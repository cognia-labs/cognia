/**
 * `vscode.authentication.*` backing store for the VS Code reuse layer.
 *
 * Two surfaces this module powers:
 *   1. `vscode.authentication.registerAuthenticationProvider(id, label, provider)`
 *      → `registerAuthenticationProvider(...)` here.
 *   2. `vscode.authentication.getSession(providerId, scopes, options)`
 *      → `getSession(providerId, scopes, options)` here.
 *
 * The registry keeps legacy sessions in their providers. The Host connection
 * store owns durable credentials, revisions, refresh and revocation (ADR-0246).
 * The old secrets-adapter exports remain inert compatibility APIs.
 *
 * A built-in GitHub provider lives at `auth-providers/github.ts` (registered
 * by the renderer's bootstrap, not here) — it reuses the claude-subscription
 * OAuth helpers.
 */

import { nanoid } from "nanoid"
import type {
  AuthAttemptContext,
  AuthCallbackParams,
  AuthCredentialSet,
  AuthIdentityDescription,
  AuthLineageContext,
} from "../../../types/plugin/plugin-auth"

/** A provider's structured, permanent rejection of the stored refresh grant. */
export class AuthRefreshRejected extends Error {
  readonly code = "invalid_grant"
  constructor(message = "The refresh grant was rejected") {
    super(message)
    this.name = "AuthRefreshRejected"
  }
}

/** Refresh is bounded by the Host; providers should abort their I/O on signal. */
export interface AuthRefreshContext extends AuthLineageContext {
  signal?: AbortSignal
}

export interface AuthSession {
  /** Stable id assigned when the session was created. */
  id: string
  /** Bearer token / API key. Persisted via cognia's secrets API. */
  accessToken: string
  /** Account identifier — typically email or user-id. */
  account: { id: string; label: string }
  /** Scopes granted with this session. Sorted for deterministic comparison. */
  scopes: string[]
}

export interface AuthSessionChangeEvent {
  providerId: string
  added: AuthSession[]
  removed: AuthSession[]
  changed: AuthSession[]
}

export interface AuthSessionOptions {
  createIfNone?: boolean
  forceNewSession?: boolean
  silent?: boolean
  clearSessionPreference?: boolean
  /** Provider-specific setup values collected by a host-owned form. */
  configuration?: Record<string, unknown>
}

export interface AuthSessionAddedEvent {
  provider: string
  session: AuthSession
}

export interface AuthSessionRemovedEvent {
  provider: string
  sessionId: string
}

export interface AuthenticationProvider {
  /** Stable provider identifier — e.g. `"github"`, `"microsoft"`. */
  id: string
  /** Human-readable label for the consent UI. */
  label: string
  /**
   * The plugin that registered this provider. `null` means the built-in
   * cognia provider (no plugin owns it).
   */
  pluginId: string | null
  /**
   * Create or retrieve a session for the supplied scopes. VS Code spec:
   * `createIfNone` triggers interactive auth; `silent` returns `null`
   * when no existing session matches.
   */
  getSessions: (
    scopes: readonly string[] | undefined,
    options: AuthSessionOptions
  ) => Promise<AuthSession[]>
  /** Open the interactive consent flow and return the resulting session. */
  createSession: (scopes: readonly string[], options?: AuthSessionOptions) => Promise<AuthSession>
  /** Resolve a short-lived request credential without exposing it to plugin code. */
  resolveRequestCredential?: (
    sessionId: string,
    context: AuthRequestCredentialContext
  ) => Promise<ResolvedAuthRequestCredential>
  /** Revoke a session. Idempotent. */
  removeSession: (sessionId: string) => Promise<void>
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

export interface AuthRequestCredentialContext {
  connectorAccountId: string
  origin: string
}

export interface ResolvedAuthRequestCredential {
  accessToken: string
  expiresAt?: string
}

export interface SecretsAdapter {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

const providers = new Map<string, AuthenticationProvider>()

const sessionListeners = new Set<(event: AuthSessionChangeEvent) => void>()

/**
 * @deprecated Inert compatibility API. Host connections own persistence;
 * installing an adapter never reads, writes or deletes legacy session tokens.
 */
export function setSecretsAdapter(_adapter: SecretsAdapter | null): void {}

function emit(event: AuthSessionChangeEvent): void {
  queueMicrotask(() => {
    for (const listener of sessionListeners) {
      try {
        listener(event)
      } catch (err) {
        console.warn("Auth session listener threw:", err)
      }
    }
  })
}

const providerWaiters = new Map<string, Set<(provider: AuthenticationProvider) => void>>()

export function registerAuthenticationProvider(provider: AuthenticationProvider): () => void {
  if (providers.has(provider.id)) {
    console.warn(
      `Auth provider "${provider.id}" replaced (was owned by "${providers.get(provider.id)?.pluginId ?? "cognia"}").`
    )
  }
  providers.set(provider.id, provider)
  const waiters = providerWaiters.get(provider.id)
  providerWaiters.delete(provider.id)
  for (const resolve of waiters ?? []) resolve(provider)
  return () => {
    if (providers.get(provider.id) === provider) unregisterAuthenticationProvider(provider.id)
  }
}

/**
 * The provider registered as `id`, waiting up to `timeoutMs` for one to be
 * registered (by an extension that was just started for it).
 */
export function waitForProvider(
  id: string,
  timeoutMs: number
): Promise<AuthenticationProvider | undefined> {
  const existing = providers.get(id)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve) => {
    const waiters = providerWaiters.get(id) ?? new Set()
    providerWaiters.set(id, waiters)
    const settle = (provider: AuthenticationProvider | undefined) => {
      clearTimeout(timer)
      waiters.delete(settle)
      if (waiters.size === 0 && providerWaiters.get(id) === waiters) providerWaiters.delete(id)
      resolve(provider)
    }
    const timer = setTimeout(() => settle(undefined), timeoutMs)
    waiters.add(settle)
  })
}

export function unregisterAuthenticationProvider(id: string): void {
  providers.delete(id)
}

export function unregisterProvidersByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, p] of providers) {
    if (p.pluginId === pluginId) {
      providers.delete(id)
      removed += 1
    }
  }
  return removed
}

export function listProviders(): AuthenticationProvider[] {
  return [...providers.values()]
}

export function getProvider(id: string): AuthenticationProvider | undefined {
  return providers.get(id)
}

/**
 * VS Code's `getSession` contract:
 *   - When `createIfNone` is true and no session matches, open the
 *     interactive flow and return the new session.
 *   - When `silent` is true and no session matches, return `undefined`.
 *   - When neither flag is set, return an existing session if any, or
 *     `undefined` otherwise (caller is expected to call again with
 *     `createIfNone`).
 */
export async function getSession(
  providerId: string,
  scopes: readonly string[],
  options: AuthSessionOptions = {}
): Promise<AuthSession | undefined> {
  const provider = providers.get(providerId)
  if (!provider) {
    throw new Error(`No auth provider registered for id "${providerId}"`)
  }
  const existing = await provider.getSessions(scopes, { silent: true })
  if (!options.forceNewSession && existing.length > 0) {
    const match = existing.find((s) => scopesMatch(s.scopes, scopes))
    if (match) return match
  }
  if (options.createIfNone || options.forceNewSession) {
    const session = await provider.createSession(scopes, options)
    emit({ providerId, added: [session], removed: [], changed: [] })
    return session
  }
  return undefined
}

export async function removeSession(providerId: string, sessionId: string): Promise<void> {
  const provider = providers.get(providerId)
  if (!provider) return
  // Look up the row so the change-event carries the metadata.
  const existing = await provider.getSessions(undefined, { silent: true })
  const session = existing.find((s) => s.id === sessionId)
  await provider.removeSession(sessionId)
  if (session) {
    emit({ providerId, added: [], removed: [session], changed: [] })
  }
}

export function onDidChangeSessions(listener: (event: AuthSessionChangeEvent) => void): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

/** @deprecated Inert: Host connections replace session hydration. Always returns 0. */
export async function hydrateFromSecrets(): Promise<number> {
  return 0
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function scopesMatch(actual: string[], requested: readonly string[]): boolean {
  if (requested.length === 0) return true
  const set = new Set(actual)
  return requested.every((s) => set.has(s))
}

export function __makeSession(input: {
  accessToken: string
  account: { id: string; label: string }
  scopes: readonly string[]
}): AuthSession {
  return {
    id: nanoid(),
    accessToken: input.accessToken,
    account: input.account,
    scopes: [...input.scopes].sort(),
  }
}

export function __resetAuthRegistryForTesting(): void {
  providers.clear()
  providerWaiters.clear()
  sessionListeners.clear()
}
