/** Optional integration behavior consumed by a Host-neutral runtime coordinator. */
import type { ProtocolAdapter, SessionCreateOptions, CatalogModel } from "./adapter"
import type {
  AcpPermissionMode,
  AcpSessionModelState,
  ExternalAgentConfig,
  ExternalAgentExecutionOptions,
  ExternalAgentSession,
} from "./external-agent"
export interface ProcessWriteScope {
  roots: string[]
  ceiling?: string[]
  permissionMode: AcpPermissionMode | undefined
  users: number
  ready: Promise<void>
}
export interface NativeChildSession {
  id: string
  parentId: string
  title: string
  completed: boolean
  transcript: string
}
export interface NativeChildControls {
  listChildren(parentId: string): Promise<string[]>
  inspect(parentId: string, childId: string): Promise<NativeChildSession>
  recoveryPrompt(parentId: string, childId: string): Promise<string>
}
/** Package-owned reconciliation of an asynchronously projected native session index. */
export interface AgentSessionCatalog {
  deleted(sessionId: string, cwd?: string): void
  listed<T extends { sessionId: string }>(sessions: T[], options?: { cwd?: string }): T[]
  clear(): void
}
export interface AgentRuntimePolicy {
  createSessionCatalog?(config: ExternalAgentConfig): AgentSessionCatalog | undefined
  prepareTaskConfig?(config: ExternalAgentConfig): Promise<ExternalAgentConfig>
  serializeConnections?: boolean
  ownsConnectionTimeout?: boolean
  ownsExecutionRetries?: boolean
  passEffectivePermissionMode?: boolean
  scopeLabel?: string
  processWriteScope?: boolean
  requestedWritableRoots?(
    config: ExternalAgentConfig,
    mode: AcpPermissionMode | undefined,
    report: (root: string, reason: string) => void
  ): string[]
  connectionConfig?(
    config: ExternalAgentConfig,
    scope: ProcessWriteScope | undefined
  ): ExternalAgentConfig
  sessionMetadata?(
    config: ExternalAgentConfig,
    options: ExternalAgentExecutionOptions | undefined,
    scope: ProcessWriteScope | undefined
  ): Record<string, unknown>
  authoritativeSessions?(adapter: ProtocolAdapter): boolean
  handleProcessExit?(adapter: ProtocolAdapter, processId: string): Promise<string[] | undefined>
  prepareCachedSession?(
    adapter: ProtocolAdapter,
    session: ExternalAgentSession,
    options: SessionCreateOptions
  ): Promise<ExternalAgentSession | undefined>
  nativeChildren?(adapter: ProtocolAdapter): NativeChildControls | undefined
  discoverModels?(
    adapter: ProtocolAdapter
  ): Promise<
    | { kind: "session-models"; models: AcpSessionModelState }
    | { kind: "catalog"; models: CatalogModel[] }
    | undefined
  >
  projectCapabilities?(
    config: ExternalAgentConfig,
    capabilities: ProtocolAdapter["capabilities"]
  ): ProtocolAdapter["capabilities"]
}
export const DEFAULT_RUNTIME_POLICY: Readonly<AgentRuntimePolicy> = Object.freeze({})
