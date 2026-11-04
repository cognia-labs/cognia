/** Host authorization for a process-wide write lease. Integrations cannot widen this grant. */
import type { ProtocolAdapter } from "@cognia/agent-contracts/adapter"
import type { AgentRuntimePolicy, ProcessWriteScope } from "@cognia/agent-contracts/runtime-policy"
import type {
  ExternalAgentInstance,
  ExternalAgentSession,
  AcpPermissionMode,
} from "@cognia/agent-contracts/external-agent"
import type { ExternalAgentCapabilityProfileV1 } from "@cognia/agent-contracts/external-agent-capability"
import {
  enforceExternalPermissionCeiling,
  type PermissionBoundExternalExecutionOptions,
} from "../policy/permission-ceiling"
interface WriteAuthorityHost {
  instance?: ExternalAgentInstance
  adapter?: ProtocolAdapter
  policy: AgentRuntimePolicy
  profile: ExternalAgentCapabilityProfileV1 | undefined
  scopes: Map<string, ProcessWriteScope>
  connections: Map<string, Promise<void>>
  resolvePermissionMode(
    instance: ExternalAgentInstance,
    mode?: AcpPermissionMode
  ): AcpPermissionMode | undefined
  warn(message: string, data: Record<string, unknown>): void
  normalizeError(error: unknown): string
  liveSessions(): ExternalAgentSession[]
  latestSession(sessions: ExternalAgentSession[]): ExternalAgentSession | undefined
  disconnect(): Promise<void>
}
export async function acquireProcessWriteScope(
  agentId: string,
  options: PermissionBoundExternalExecutionOptions | undefined,
  host: WriteAuthorityHost
): Promise<{ options: PermissionBoundExternalExecutionOptions | undefined; release(): void }> {
  const instance = host.instance
  const adapter = host.adapter
  if (!instance || !adapter || !host.policy.processWriteScope) {
    return { options, release: () => {} }
  }
  options = enforceExternalPermissionCeiling(
    options,
    instance.config.protocol,
    instance.capabilities,
    instance.config.defaultPermissionMode,
    host.profile
  )
  const mode = host.resolvePermissionMode(instance, options?.permissionMode)
  const report = (root: string, reason: string) => {
    host.warn("Codex extra writable root was refused", {
      agentId,
      root,
      reason,
    })
  }
  const { sandboxSessionRuntime } = await import("@/lib/sandbox/session-runtime")
  const { narrowRequiredWriteScope } = await import("@/lib/sandbox/policy-bridge")
  const custom = options?.context?.custom
  const nativeSessionId =
    options?.sessionId ?? (typeof custom?.sessionId === "string" ? custom.sessionId : undefined)
  const nativeSession = nativeSessionId
    ? (instance.sessions.get(nativeSessionId) ?? adapter.getSession(nativeSessionId))
    : undefined
  const boundChatSessionId = nativeSession?.metadata?.cogniaSessionId
  const chatSessionId =
    typeof custom?.chatSessionId === "string"
      ? custom.chatSessionId
      : typeof boundChatSessionId === "string"
        ? boundChatSessionId
        : undefined
  const ref = sandboxSessionRuntime.activeRefForSession(chatSessionId)
  // A retired runtime or a native-only resume must not erase a ceiling the
  // connected process already knows. Reuse it until an active binding replaces it.
  const configuredCeiling = ref
    ? sandboxSessionRuntime.writableRootsFor(ref)
    : host.scopes.get(agentId)?.ceiling
  const ceiling = configuredCeiling?.length ? [...configuredCeiling].sort() : undefined
  const requested = host.policy.requestedWritableRoots?.(instance.config, mode, report) ?? []
  const roots = [
    ...new Set(
      requested.flatMap((root) => {
        try {
          if (!ref)
            return ceiling ? (narrowRequiredWriteScope([root], ceiling, "writable") ?? []) : [root]
          return sandboxSessionRuntime.clampRequest(ref, {
            maxCpuSeconds: 0,
            maxMemoryMb: 0,
            network: "off",
            networkHosts: [],
            writable: [root],
            readable: [],
            targetFiles: [],
          }).writable
        } catch (error) {
          report(root, host.normalizeError(error))
          return []
        }
      })
    ),
  ].sort()
  let scope = host.scopes.get(agentId)
  const changed =
    JSON.stringify([scope?.roots ?? [], scope?.ceiling]) !== JSON.stringify([roots, ceiling])
  if (
    changed &&
    (scope?.users || host.liveSessions().some((session) => session.status === "executing"))
  ) {
    throw new Error(
      `${host.policy.scopeLabel ?? "Process"} writable roots cannot change while another session is executing`
    )
  }
  if (!scope || changed) {
    // Disconnect clears session caches. Preserve the conversation's native
    // session so the normal resolver resumes it under the narrower process.
    if (
      changed &&
      !options?.resetExternalSession &&
      !options?.sessionId &&
      !custom?.sessionId &&
      chatSessionId
    ) {
      const previous = host.latestSession(
        adapter
          .getSessions()
          .filter((session) => session.metadata?.cogniaSessionId === chatSessionId)
      )
      if (previous) options = { ...options, sessionId: previous.id }
    }
    scope = { roots, ceiling, permissionMode: mode, users: 0, ready: Promise.resolve() }
    host.scopes.set(agentId, scope)
    if (changed && (adapter.isConnected() || host.connections.has(agentId))) {
      scope.ready = host.disconnect()
    }
  }
  const acquiredScope = scope
  acquiredScope.users++
  const release = () => {
    acquiredScope.users--
    if (
      acquiredScope.users === 0 &&
      !adapter.isConnected() &&
      host.scopes.get(agentId) === acquiredScope
    ) {
      host.scopes.delete(agentId)
    }
  }
  try {
    await scope.ready
    return { options, release }
  } catch (error) {
    release()
    if (host.scopes.get(agentId) === scope) host.scopes.delete(agentId)
    throw error
  }
}
