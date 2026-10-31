/**
 * The plugin contract's share of `lib/plugin/api/auth-api.ts`, which re-exports these.
 */
import type { AuthSession, AuthSessionOptions } from "../auth/auth-provider-registry"
import type { PkceFlowConfig, PkceTokenResult } from "../auth/auth-pkce-flow"
import type { PluginAuthSessionChangeEvent } from "../../../types/plugin/plugin-auth"
import type { PluginNetworkAPI } from "../../../types/plugin/plugin"

export type {
  PluginAuthSessionChangeEvent,
  PluginAuthSessionMetadata,
} from "../../../types/plugin/plugin-auth"

/** The host supplies the governed transport; plugins cannot override it. */
export type PluginPkceFlowConfig = Omit<PkceFlowConfig, "fetchImpl">

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
}

export interface PluginAuthAPI {
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
}

export interface CreateAuthAPIOptions {
  hasPermission: (permission: string) => boolean
  /** Host-owned, permission-guarded plugin network API. */
  network?: Pick<PluginNetworkAPI, "fetch">
}
