/** Credential-resolved MCP maps share the Host personal gate with invocation. */
import type { McpServer } from "@cognia/agent-config-types"
import type { McpServerWireConfig } from "@cognia/agent-config-types/claude-agent-sdk-options"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import { PersonalCredentialRefusedError } from "@/lib/execution/personal-credential"
import { resolveMcpRuntimeCredential } from "./credential-resolver"

export interface RunMcpServerMapDeps {
  isTauri?: () => boolean
  credentialContext?: PersonalCredentialContext
  onRefusal?: (server: McpServer, reason: string) => void
}
export async function buildRunMcpServerMap(
  servers: McpServer[],
  deps: RunMcpServerMapDeps = {}
): Promise<Record<string, McpServerWireConfig>> {
  const admitted: McpServer[] = []
  for (const server of servers) {
    try {
      const credential = await resolveMcpRuntimeCredential(server, {
        isDesktop: deps.isTauri,
        credentialContext: deps.credentialContext,
      })
      admitted.push(credential.server)
    } catch (err) {
      const reason =
        err instanceof PersonalCredentialRefusedError
          ? err.decision.reason
          : "credential-unavailable"
      console.warn(`MCP server ${server.name} withheld: ${reason}`)
      deps.onRefusal?.(server, reason)
    }
  }
  const { buildMcpServerMapResolved } = await import("@/lib/db/mcp-servers")
  return buildMcpServerMapResolved(admitted)
}
