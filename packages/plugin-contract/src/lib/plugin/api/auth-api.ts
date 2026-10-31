/**
 * The plugin contract's share of `lib/plugin/api/auth-api.ts`, which re-exports these.
 */
import type {
  AuthSession,
  AuthSessionOptions,
  AuthRefreshContext,
} from "../auth/auth-provider-registry"
export { AuthRefreshRejected } from "../auth/auth-provider-registry"
import type { PkceFlowConfig, PkceTokenResult } from "../auth/auth-pkce-flow"
import type {
  AuthAttemptContext,
  AuthCallbackParams,
  AuthConnectionChangeEvent,
  AuthConnectionGrantDecision,
  AuthConnectionGrantRequest,
  AuthConnectionMetadata,
  AuthConnectionRef,
  AuthCredentialSet,
  AuthIdentityDescription,
  AuthLineageContext,
  PluginAuthSessionChangeEvent,
} from "../../../types/plugin/plugin-auth"
import type { PluginNetworkAPI } from "../../../types/plugin/plugin"

export type * from "../../../types/plugin/plugin-auth"

/** The host supplies the governed transport; plugins cannot override it. */
export type PluginPkceFlowConfig = Omit<PkceFlowConfig, "fetchImpl">

/** The trusted Host injects its client secret; it never crosses into ctx. */
export interface ConfidentialExchangeRequest {
  providerId: string
  tokenUrl: string
  params: Record<string, string>
  clientId: string
  placement: "none" | "form" | "json" | "basic"
}

export interface ConfidentialExchangeResponse {
  status: number
  body: Record<string, unknown>
}

/** Provider object a plugin registers via `ctx.auth.registerProvider`. */
export interface PluginAuthProvider {
  id: string
  label: string
  getSessions(
    scopes: readonly string[] | undefined,
    options: AuthSessionOptions
  ): Promise<AuthSession[]>
  createSession(scopes: readonly string[], options?: AuthSessionOptions): Promise<AuthSession>
  removeSession(sessionId: string): Promise<void>
  /** Exchange an accepted callback for credentials. Only the Host calls this (ADR-0246 §5, §6). */
  exchange?(attempt: AuthAttemptContext, callback: AuthCallbackParams): Promise<AuthCredentialSet>
  /**
   * Refresh under the Host's lineage lock (ADR-0246 §5). Honor signal for the
   * Host timeout. Throw AuthRefreshRejected or { code/error: "invalid_grant" }
   * for permanent rejection; message text is never classified. Other failures
   * remain retryable. Never schedule refresh yourself.
   */
  refresh?(lineage: AuthRefreshContext): Promise<AuthCredentialSet>
  /** Revoke a lineage at the vendor. The Host calls this after writing its revocation barrier (ADR-0246 §5). */
  revoke?(lineage: AuthLineageContext): Promise<void>
  /** Describe the remote identity behind fresh credentials, for the Host's connection record (ADR-0246 §2). */
  describe?(credentials: AuthCredentialSet): Promise<AuthIdentityDescription>
}

/**
 * Consumer connection API (`auth:consume`). A connection is visible only to its
 * provider owner or a consumer declaring a required/optional service provided
 * by that owner. Host providers require an explicit Host provider/service map;
 * that map starts empty until the built-in Lark/Google providers adopt this
 * contract (ADR-0246 P5/P6). Invisible references behave exactly like absent ones.
 */
export interface PluginAuthConnectionsAPI {
  /** Select a connection matching the consumer's provider, service and scopes. */
  get(request: {
    providerId?: string
    service?: string
    scopes?: readonly string[]
    interactive?: boolean
  }): Promise<AuthConnectionMetadata | undefined>
  /** List connection metadata without exposing credentials. */
  list(filter?: { providerId?: string; service?: string }): Promise<AuthConnectionMetadata[]>
  /** Ask the Host to authorize this consumer at the connection's current revision. */
  requestGrant(
    ref: AuthConnectionRef,
    request: AuthConnectionGrantRequest
  ): Promise<AuthConnectionGrantDecision>
  /** Observe connection metadata changes, optionally for one provider. */
  onDidChange(
    listener: (event: AuthConnectionChangeEvent) => void,
    filter?: { providerId?: string }
  ): () => void
}

export interface PluginAuthAPI {
  /** Credential-free, Host-selected connections and consumer grants. */
  connections: PluginAuthConnectionsAPI
  /** Register an authentication provider (`auth:provide`). Returns a disposer. */
  registerProvider(provider: PluginAuthProvider): () => void
  /** Get (or interactively create) a session for a provider (`auth:consume`). */
  getSession(
    providerId: string,
    scopes: readonly string[],
    options?: AuthSessionOptions
  ): Promise<AuthSession | undefined>
  /** List existing sessions for a provider, silent (`auth:consume`). */
  getSessions(providerId: string, scopes?: readonly string[]): Promise<AuthSession[]>
  /** Observe session metadata (`auth:consume`), optionally for one provider. */
  onDidChangeSessions(
    listener: (event: PluginAuthSessionChangeEvent) => void,
    providerId?: string
  ): () => void
  /** Run an OAuth 2.0 + PKCE flow (`auth:provide` + `network:fetch`). Returns the raw tokens. */
  createPkceFlow(config: PluginPkceFlowConfig): Promise<PkceTokenResult>
  /** Exchange at a declared token endpoint (`auth:provide` + `network:fetch`).
   * Requires desktop or an always-on Host; otherwise NOT_SUPPORTED (ES-33).
   */
  exchangeConfidential(request: ConfidentialExchangeRequest): Promise<ConfidentialExchangeResponse>
}

export interface CreateAuthAPIOptions {
  hasPermission: (permission: string) => boolean
  /** Host-owned, permission-guarded plugin network API. */
  network?: Pick<PluginNetworkAPI, "fetch">
}
