import type {
  AuthConnectionRef,
  AuthCredentialSet,
  AuthMethod,
  PluginAuthProviderDef,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getPlugin } from "@/lib/db/plugins"
import { getAuthConnection } from "@/lib/db/auth-connections"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"
import { getProvider } from "./auth-provider-registry"
import {
  createAttempt,
  consumeAttempt,
  cancelAttempt,
  AuthAttemptRejected,
  type AuthAttempt,
} from "./auth-attempts"
import { registerAuthCallbackWaiter } from "./callback-acceptor"
import {
  getConnectionManager,
  ReconnectIdentityMismatch,
  ConnectionRevisionChanged,
  ConnectionIdentityConflict,
  ConnectionUnavailableError,
} from "./connection-manager"

/** Fixed messages only: vendor exceptions may contain credentials or callback codes. */
export class AuthConnectError extends Error {
  constructor(
    readonly code:
      | "NOT_SUPPORTED"
      | "NOT_FOUND"
      | "INVALID_REQUEST"
      | "CANCELLED"
      | "TIMEOUT"
      | "INTERNAL"
      | "UNAVAILABLE",
    readonly reason: string
  ) {
    super(`Host sign-in failed: ${reason}`)
    this.name = "AuthConnectError"
  }
}

export interface ConnectProviderRequest {
  providerId: string
  scopes: readonly string[]
  method?: AuthMethod
  reconnect?: AuthConnectionRef
  signal?: AbortSignal
}

/** Host sign-in orchestration, separate from credential persistence and callback acceptance. */
export async function connectProvider(request: ConnectProviderRequest): Promise<AuthConnectionRef> {
  let attempt: AuthAttempt | undefined
  let waiter: ReturnType<typeof registerAuthCallbackWaiter> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  let fresh: AuthCredentialSet | undefined
  let interrupted = false
  let committing = false
  const { providerId, method: requestedMethod, reconnect, signal } = request
  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  signal?.addEventListener("abort", forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()
  const provider = getProvider(providerId)
  const active = () => {
    if (controller.signal.aborted) throw new AuthConnectError("CANCELLED", "cancelled")
    if (getProvider(providerId) !== provider)
      throw new AuthConnectError("UNAVAILABLE", "provider-unavailable")
  }
  try {
    active()
    if (!provider) throw new AuthConnectError("NOT_FOUND", "provider-not-registered")
    if (requestedMethod === "device-code")
      throw new AuthConnectError("NOT_SUPPORTED", "device-code-deferred")
    const scopes = [...new Set(request.scopes)]
    const manager = getConnectionManager()
    const original = reconnect ? await getAuthConnection(reconnect) : undefined
    if (reconnect && !original) throw new AuthConnectError("NOT_FOUND", "reconnect-not-found")
    const expectedRevision =
      original && original.status !== "revoked" && original.status !== "tombstoned"
        ? original.revision
        : undefined
    if (!provider.describe) {
      const session = await provider.createSession(scopes)
      try {
        active()
        return await manager.ensureLegacyConnection(providerId, session, {
          reconnect,
          signal: controller.signal,
          expectedRevision,
        })
      } catch (error) {
        try {
          await provider.removeSession(session.id)
        } catch {
          /* Best effort; never log vendor errors. */
        }
        throw error
      }
    }
    const manifest =
      provider.pluginId === null ? undefined : (await getPlugin(provider.pluginId))?.manifest
    const declarations = manifest?.authProviders
    // Installed manifests are validated at install time, but the database
    // intentionally stores their JSON as Record<string, unknown>.
    const definition = (
      Array.isArray(declarations)
        ? declarations.find((item: PluginAuthProviderDef) => item.id === providerId)
        : undefined
    ) as PluginAuthProviderDef | undefined
    if (provider.pluginId !== null && !definition)
      throw new AuthConnectError("UNAVAILABLE", "provider-declaration-missing")
    const supported = (method: AuthMethod) =>
      Boolean(
        provider.exchange &&
        (method === "client-credentials" || (method === "oauth-pkce" && provider.authorize))
      )
    const declared = definition?.methods ?? (["oauth-pkce", "client-credentials"] as AuthMethod[])
    const method = requestedMethod ?? declared.find(supported)
    if (!method || !declared.includes(method) || !supported(method))
      throw new AuthConnectError("NOT_SUPPORTED", "auth-method-unavailable")
    const configuration = provider.authorization
    if (!configuration?.clientId || !configuration.issuer)
      throw new AuthConnectError("INVALID_REQUEST", "authorization-configuration-missing")
    const issuer = new URL(configuration.issuer)
    if (
      issuer.protocol !== "https:" ||
      issuer.origin !== configuration.issuer ||
      issuer.username ||
      issuer.password
    )
      throw new AuthConnectError("INVALID_REQUEST", "invalid-issuer")
    const allowed = definition?.issuers
    if (allowed && !allowed.includes(issuer.origin))
      throw new AuthConnectError("INVALID_REQUEST", "undeclared-issuer")
    const redirectUri =
      method === "oauth-pkce"
        ? (configuration.redirectUri ??
          (isTauri()
            ? "cognia://auth/callback"
            : typeof window !== "undefined"
              ? `${window.location.origin}/plugin-auth/callback`
              : undefined))
        : undefined
    if (method === "oauth-pkce" && !redirectUri)
      throw new AuthConnectError("NOT_SUPPORTED", "browser-unavailable")
    active()
    const binding = { providerId, clientId: configuration.clientId, issuer: issuer.origin }
    attempt = await createAttempt({ ...binding, method, scopes, redirectUri })
    // Bound the entire exchange too. Providers which ignore cancellation may
    // finish later, but their newly issued credentials can never be committed.
    const stopped = new Promise<never>((_, reject) => {
      const fail = (code: "CANCELLED" | "TIMEOUT", reason: string) => {
        if (committing) return
        interrupted = true
        reject(new AuthConnectError(code, reason))
        controller.abort()
      }
      stop = () => fail("CANCELLED", "cancelled")
      signal?.addEventListener("abort", stop, { once: true })
      timer = setTimeout(
        () => fail("TIMEOUT", "attempt-expired"),
        Math.max(0, attempt!.expiresAt - Date.now())
      )
      if (signal?.aborted) stop()
    })
    void stopped.catch(() => {})
    const bounded = <T>(task: Promise<T>) => Promise.race([task, stopped])
    let callback
    let accepted = attempt
    if (method === "oauth-pkce") {
      waiter = registerAuthCallbackWaiter(attempt.state, binding, attempt.expiresAt)
      void waiter.promise.catch(() => {})
      const result = await bounded(provider.authorize!({ ...attempt, scopes: [...scopes] }))
      let url: URL
      try {
        url = new URL(result.url)
      } catch {
        throw new AuthConnectError("INVALID_REQUEST", "invalid-authorize-url")
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (allowed && !allowed.includes(url.origin))
      )
        throw new AuthConnectError("INVALID_REQUEST", "invalid-authorize-origin")
      active()
      await bounded(openExternal(url.href))
      const response = await bounded(waiter.promise)
      accepted = response.attempt
      callback = response.callback
      if (callback.error || !callback.code)
        throw new AuthConnectError("UNAVAILABLE", "authorization-rejected")
    } else {
      accepted = await bounded(consumeAttempt(attempt.state, binding))
      callback = { state: attempt.state }
    }
    active()
    const exchange = Promise.resolve()
      .then(() => provider.exchange!({ ...accepted, scopes: [...accepted.scopes] }, callback))
      .then(async (credentials) => {
        if (interrupted) await manager.discardCredentials(provider, credentials)
        return credentials
      })
    fresh = await bounded(exchange)
    active()
    const credentials = fresh
    fresh = undefined // The manager owns cleanup from here, including identity mismatch.
    return await bounded(
      manager.createConnectionFromCredentials(provider, credentials, {
        reconnect,
        signal: controller.signal,
        expectedRevision,
        binding,
        onCommit: () => {
          // From metadata publication onward the commit result wins. Never
          // report cancellation and then publish a successful sign-in later.
          committing = true
          clearTimeout(timer)
          if (stop) signal?.removeEventListener("abort", stop)
          signal?.removeEventListener("abort", forwardAbort)
        },
      })
    )
  } catch (error) {
    if (
      error instanceof AuthConnectError ||
      error instanceof ReconnectIdentityMismatch ||
      error instanceof ConnectionRevisionChanged ||
      error instanceof ConnectionIdentityConflict
    )
      throw error
    if (signal?.aborted) throw new AuthConnectError("CANCELLED", "cancelled")
    if (error instanceof AuthAttemptRejected)
      throw new AuthConnectError(error.reason === "expired" ? "TIMEOUT" : "CANCELLED", error.reason)
    if (error instanceof ConnectionUnavailableError)
      throw new AuthConnectError("UNAVAILABLE", error.reason)
    throw new AuthConnectError("INTERNAL", "provider-or-storage-failed")
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forwardAbort)
    if (stop) signal?.removeEventListener("abort", stop)
    if (fresh && provider) await getConnectionManager().discardCredentials(provider, fresh)
    try {
      if (waiter) await waiter.cancel()
      else if (attempt) await cancelAttempt(attempt.state)
    } catch {
      console.warn("Auth sign-in attempt cleanup failed")
    }
  }
}
