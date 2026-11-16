/**
 * MCP server discovery from settings: the Host checks policy, resolves
 * secrets and audits, then the sidecar gateway lists the server's
 * capabilities over an ephemeral connection.
 */
import type { McpCapabilityCacheRow, McpServer } from "@cognia/agent-config-types"

import { defaultClient } from "@/lib/ai/agent/execution/sidecar-feature-client"
import { appendMcpAuditLog } from "@/lib/db/mcp-audit-log"
import { resolveMcpSecrets } from "@/lib/mcp/credentials"
import { evaluateMcpPolicy } from "@/lib/mcp/policy"

export interface McpDiscoveryResult {
  ok: boolean
  toolCount: number
  tools: McpCapabilityCacheRow["tools"]
  resources: McpCapabilityCacheRow["resources"]
  prompts: McpCapabilityCacheRow["prompts"]
  durationMs: number
  error?: string
}

function failedMcpDiscovery(
  error: unknown,
  startedAt: number,
  now = Date.now()
): McpDiscoveryResult {
  return {
    ok: false,
    toolCount: 0,
    tools: [],
    resources: [],
    prompts: [],
    durationMs: now - startedAt,
    error: error instanceof Error ? error.message : String(error),
  }
}

function appendMcpAuditSafely(
  draft: Parameters<typeof appendMcpAuditLog>[0],
  append: typeof appendMcpAuditLog
): void {
  void append(draft).catch(() => undefined)
}

export interface McpDiscoveryDependencies {
  requestResult?: typeof defaultClient.requestResult
  resolveSecrets?: typeof resolveMcpSecrets
  appendAudit?: typeof appendMcpAuditLog
  now?: () => number
}

/** Resolve credentials in the host and discover through the sidecar gateway. */
export async function discoverMcpServerViaSidecar(
  server: McpServer,
  abortSignal?: AbortSignal,
  dependencies: McpDiscoveryDependencies = {}
): Promise<McpDiscoveryResult> {
  const now = dependencies.now ?? (() => Date.now())
  const requestResult = dependencies.requestResult ?? defaultClient.requestResult
  const resolveSecrets = dependencies.resolveSecrets ?? resolveMcpSecrets
  const appendAudit = dependencies.appendAudit ?? appendMcpAuditLog
  const startedAt = now()
  const policy = evaluateMcpPolicy({
    server,
    surface: "settings",
    interactive: false,
  })
  if (policy.decision !== "allow") {
    const result = failedMcpDiscovery(new Error(policy.reason), startedAt, now())
    appendMcpAuditSafely(
      {
        ts: startedAt,
        tool: "capabilities/list",
        scope: "n/a",
        allowed: false,
        latencyMs: result.durationMs,
        direction: "outbound",
        phase: "discover",
        serverId: server.id,
        executionSurface: "settings",
        decision: policy.decision,
        durationMs: result.durationMs,
        errorCode: "policy-denied",
      },
      appendAudit
    )
    return result
  }

  try {
    const config = await resolveSecrets(server.config)
    const result = (await requestResult(
      {
        operation: "mcp-discover",
        credentials: {},
        mcpServer: {
          id: server.id,
          name: server.name,
          transport: server.transport,
          config,
        },
      },
      abortSignal
    )) as McpDiscoveryResult
    appendMcpAuditSafely(
      {
        ts: startedAt,
        tool: "capabilities/list",
        scope: "n/a",
        allowed: true,
        latencyMs: result.durationMs,
        direction: "outbound",
        phase: "discover",
        serverId: server.id,
        executionSurface: "settings",
        decision: "allow",
        durationMs: result.durationMs,
      },
      appendAudit
    )
    return result
  } catch (error) {
    const result = failedMcpDiscovery(error, startedAt, now())
    appendMcpAuditSafely(
      {
        ts: startedAt,
        tool: "capabilities/list",
        scope: "n/a",
        allowed: true,
        latencyMs: result.durationMs,
        direction: "outbound",
        phase: "discover",
        serverId: server.id,
        executionSurface: "settings",
        decision: "allow",
        durationMs: result.durationMs,
        errorCode: abortSignal?.aborted ? "aborted" : "discovery-failed",
      },
      appendAudit
    )
    return result
  }
}
