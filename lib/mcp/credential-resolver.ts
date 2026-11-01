import {
  admitPersonalCredential,
  PersonalCredentialRefusedError,
  type PersonalCredentialContext,
} from "@/lib/execution/personal-credential"
import type { McpServer } from "@cognia/agent-config-types"

import { isTauri } from "@/lib/tauri"
import {
  mcpOAuthLoadEntry,
  mcpOAuthStatus,
  mcpOAuthRefresh,
  type McpOAuthEntry,
  type McpServerDescriptor,
} from "./oauth-tauri"

export interface ResolvedMcpRuntimeCredential {
  server: McpServer
  refreshAuth?: () => Promise<{ server: McpServer }>
}

interface CredentialResolverDeps {
  credentialContext?: PersonalCredentialContext
  status?: typeof mcpOAuthStatus
  isDesktop?: () => boolean
  now?: () => number
  loadEntry?: typeof mcpOAuthLoadEntry
  refresh?: typeof mcpOAuthRefresh
  refreshSkewMs?: number
  /** The Registry row as it is now; defaults to `getMcpServer`. */
  getCurrent?: (id: string) => Promise<McpServer | undefined>
}

/** Resolve keychain OAuth for every governed runtime without exposing tokens to Agent context. */
export async function resolveMcpRuntimeCredential(
  server: McpServer,
  deps: CredentialResolverDeps = {}
): Promise<ResolvedMcpRuntimeCredential> {
  if (server.transport === "stdio" || !(deps.isDesktop ?? isTauri)()) return { server }
  // Operator-configured SecretRef/static credentials never borrow personal OAuth.
  if (hasStaticMcpCredential(server)) return { server }
  const assertAdmitted = async () => {
    const decision = await admitPersonalCredential(deps.credentialContext, {
      source: "mcp-oauth",
      person: server.id,
    })
    if (!decision.ok) throw new PersonalCredentialRefusedError(decision)
  }
  const descriptor: McpServerDescriptor = { transport: server.transport, config: server.config }
  const loadEntry = deps.loadEntry ?? mcpOAuthLoadEntry
  const refresh = deps.refresh ?? mcpOAuthRefresh
  const now = deps.now ?? (() => Date.now())
  const refreshSkewMs = deps.refreshSkewMs ?? 60_000
  const decision = await admitPersonalCredential(deps.credentialContext, {
    source: "mcp-oauth",
    person: server.id,
  })
  if (!decision.ok) {
    // Status contains no bearer. An unknown status must not offer an OAuth-only
    // server that will fail authentication or trigger an interactive flow.
    const status = await (deps.status ?? mcpOAuthStatus)(server.id, server.name, descriptor).catch(
      () => undefined
    )
    if (!status || status.hasTokens) throw new PersonalCredentialRefusedError(decision)
    return { server }
  }
  let entry = await loadEntry(server.id, server.name, descriptor, deps.credentialContext)
  if (entry?.expiresAtMs && entry.expiresAtMs - now() < refreshSkewMs) {
    await assertAdmitted()
    entry = (await refresh(server.id, descriptor, deps.credentialContext)) ?? entry
  }

  const project = (
    token: McpOAuthEntry | undefined,
    credentialVersion = 0,
    base: McpServer = server
  ): McpServer => {
    if (!token?.accessToken) return base
    const headers =
      base.config.headers && typeof base.config.headers === "object"
        ? (base.config.headers as Record<string, unknown>)
        : {}
    return {
      ...base,
      credentialVersion: (base.credentialVersion ?? 0) + credentialVersion,
      config: {
        ...base.config,
        headers: { ...headers, Authorization: `Bearer ${token.accessToken}` },
      },
    }
  }

  return {
    server: project(entry),
    // The retry runs after a round trip to the token endpoint, during which
    // the user may have disabled, blocked, edited or deleted the server. Build
    // the retry from the row as it is then, so the gateway's policy check
    // judges the current definition rather than the one this call started with.
    refreshAuth: async () => {
      await assertAdmitted()
      const token = await refresh(server.id, descriptor, deps.credentialContext)
      const getCurrent =
        deps.getCurrent ??
        (async (id: string) => (await import("@/lib/db/mcp-servers")).getMcpServer(id))
      const current = await getCurrent(server.id)
      if (!current) throw new Error(`MCP server ${server.name} is no longer configured`)
      return { server: project(token, 1, current) }
    },
  }
}

/** Static operator credentials stay in the service lane, including SecretRefs. */
export function hasStaticMcpCredential(server: McpServer): boolean {
  const headers = server.config.headers
  return (
    !!headers &&
    typeof headers === "object" &&
    Object.entries(headers).some(
      ([key, value]) =>
        ((typeof value === "object" && value !== null && "secretRef" in value) ||
          /authorization|api[-_]?key|token/i.test(key)) &&
        value != null &&
        value !== ""
    )
  )
}
