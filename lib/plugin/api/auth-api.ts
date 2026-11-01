/**
 * `ctx.auth` — native auth/OAuth provider API (C1).
 *
 * Promotes the previously VS-Code-only `auth-provider-registry` into a
 * first-class native plugin surface: a plugin can REGISTER an authentication
 * provider (`auth:provide`) and CONSUME sessions from any provider
 * (`auth:consume`). Host-managed providers keep credentials in the Host's
 * connection store. Legacy providers continue to own their sessions. A PKCE helper
 * (`createPkceFlow`) wraps the reusable OAuth flow so a provider's
 * `createSession` doesn't hand-roll crypto. Like VS Code `authentication` +
 * Raycast OAuth / `withAccessToken`.
 */

import {
  registerAuthenticationProvider,
  getSession as registryGetSession,
  getProvider,
  onDidChangeSessions as registryOnDidChange,
  type AuthSession,
  type AuthenticationProvider,
} from "@/lib/plugin/auth/auth-provider-registry"
import { getAuthConnection, listAuthConnections } from "@/lib/db/auth-connections"
import { connectProvider } from "@/lib/plugin/auth/connect"
import {
  ConnectionUnavailableError,
  getConnectionManager,
} from "@/lib/plugin/auth/connection-manager"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { createAttempt } from "@/lib/plugin/auth/auth-attempts"
import { acceptCallback, registerAuthCallbackWaiter } from "@/lib/plugin/auth/callback-acceptor"
import { runPkceAuthFlow } from "@/lib/plugin/auth/auth-pkce-flow"
import { createAuthConnectionsAPI } from "@/lib/plugin/auth/connections-api"
import {
  DEFAULT_CONSUMER_TOKEN_READ_POLICY,
  enforceConsumerTokenReadPolicy,
  type ConsumerTokenReadPolicy,
} from "@/lib/plugin/auth/consumer-token-read-policy"
import {
  invokePluginApi,
  isPluginGatewayAvailable,
  PluginGatewayError,
} from "@/lib/plugin/core/transport"
export { AuthRefreshRejected } from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"
import type {
  CreateAuthAPIOptions,
  PluginAuthAPI,
  PluginAuthProvider,
  PluginAuthSessionMetadata,
} from "@cognia/plugin-contract/lib/plugin/api/auth-api"

/** Adapt connection-backed providers for the native and VS Code session surfaces. */
function hostManagedProvider(
  provider: Extract<PluginAuthProvider, { management: "host" }>,
  pluginId: string
): AuthenticationProvider {
  if (typeof provider.describe !== "function" || typeof provider.refresh !== "function")
    throw new Error("Host-managed auth providers require describe and refresh callbacks.")
  if (provider.getSessions || provider.createSession || provider.removeSession)
    throw new Error("Host-managed auth providers cannot implement session callbacks.")

  async function sessionFor(ref: AuthConnectionRef): Promise<AuthSession> {
    const manager = getConnectionManager()
    const credentials = await manager.getCredentials(ref)
    // Credential resolution may refresh or await a provider. Fence logout and
    // ownership changes after it, before returning anything to a session reader.
    const row = await manager.getConnection(ref)
    if (row.providerId !== provider.id || row.ownerPluginId !== pluginId)
      throw new ConnectionUnavailableError("provider-unavailable")
    return {
      id: row.id,
      accessToken: credentials.accessToken,
      account: { id: row.principalId, label: row.accountLabel },
      scopes: [...credentials.scopes].sort(),
    }
  }
  return {
    ...provider,
    pluginId,
    async getSessions(scopes) {
      const rows = await listAuthConnections(provider.id)
      const sessions: AuthSession[] = []
      for (const row of rows) {
        if (
          row.ownerPluginId !== pluginId ||
          row.legacySessionId ||
          row.status !== "connected" ||
          (scopes && !scopes.every((scope) => row.scopes.includes(scope)))
        )
          continue
        try {
          const session = await sessionFor(row.id)
          if (!scopes || scopes.every((scope) => session.scopes.includes(scope)))
            sessions.push(session)
        } catch (error) {
          // A concurrent disconnect or provider outage removes this session.
          if (!(error instanceof ConnectionUnavailableError)) throw error
        }
      }
      return sessions
    },
    async createSession(scopes) {
      return sessionFor(await connectProvider({ providerId: provider.id, scopes }))
    },
    async removeSession(sessionId) {
      const row = await getAuthConnection(sessionId)
      if (row?.providerId === provider.id && row.ownerPluginId === pluginId)
        await getConnectionManager().disconnect(row.id, { revoke: Boolean(provider.revoke) })
    },
  }
}
export type {
  CreateAuthAPIOptions,
  PluginAuthAPI,
  PluginAuthProvider,
  LegacyPluginAuthProvider,
  HostManagedPluginAuthProvider,
  ConfidentialExchangeRequest,
  ConfidentialExchangeResponse,
} from "@cognia/plugin-contract/lib/plugin/api/auth-api"

// Host-only provenance, never a public network option or a wire header. The
// enumerable symbol survives host option spreads. The WeakMap also rejects
// Proxy options that answer lookups for unknown symbols with forged values.
// Each entry covers one flow's token URL and is deleted when the flow ends, so
// a captured provenance object exempts nothing elsewhere or afterwards. Code
// in the host realm that patches built-ins is outside this boundary
// (ADR-0126: frontend plugins are semi-trusted).
const HOST_PKCE_TOKEN_REQUEST = Symbol("hostOAuthTokenRequest")
const hostPkceTokenRequests = new WeakMap<
  object,
  { readonly tokenUrl: string; readonly keys: readonly string[] }
>()
type HostPkceRequest = { [HOST_PKCE_TOKEN_REQUEST]?: object }

/** Read only at the host network gate; the marker itself is not exported. */
export function getHostPkceTokenRequestExemptKeys(
  options: object | undefined,
  url: string
): ReadonlySet<string> | undefined {
  const provenance = (options as HostPkceRequest | undefined)?.[HOST_PKCE_TOKEN_REQUEST]
  const entry = provenance ? hostPkceTokenRequests.get(provenance) : undefined
  return entry && entry.tokenUrl === url ? new Set(entry.keys) : undefined
}

function requirePermission(
  hasPermission: (p: string) => boolean,
  permission: string,
  method: string
): void {
  if (!hasPermission(permission)) {
    throw new Error(
      `${method} requires the "${permission}" permission to be granted and not revoked.`
    )
  }
}

export function createAuthAPI(
  pluginId: string,
  options: CreateAuthAPIOptions,
  tokenReadPolicy: ConsumerTokenReadPolicy = DEFAULT_CONSUMER_TOKEN_READ_POLICY
): PluginAuthAPI {
  const { hasPermission } = options
  return {
    connections: createAuthConnectionsAPI(pluginId, hasPermission),
    async exchangeConfidential(request) {
      requirePermission(hasPermission, "auth:provide", "ctx.auth.exchangeConfidential")
      requirePermission(hasPermission, "network:fetch", "ctx.auth.exchangeConfidential")
      if (!isPluginGatewayAvailable()) {
        throw new PluginGatewayError({
          code: "NOT_SUPPORTED",
          message: "Confidential token exchange requires a trusted Host.",
          details: { reason: "confidential-exchange-unavailable" },
          requestId: "",
          api: "auth:exchange",
          pluginId,
        })
      }
      return invokePluginApi(pluginId, "auth:exchange", request)
    },
    registerProvider(provider) {
      requirePermission(hasPermission, "auth:provide", "ctx.auth.registerProvider")
      const existing = getProvider(provider.id)
      if (existing && existing.pluginId !== pluginId) {
        throw new Error(`Auth provider "${provider.id}" is owned by another plugin.`)
      }
      return registerAuthenticationProvider(
        provider.management === "host"
          ? hostManagedProvider(provider, pluginId)
          : { ...provider, pluginId }
      )
    },
    async getSession(providerId, scopes, sessionOptions) {
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSession")
      const session = await registryGetSession(providerId, scopes, sessionOptions)
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSession")
      if (session) enforceConsumerTokenReadPolicy(pluginId, providerId, tokenReadPolicy)
      return session
    },
    async getSessions(providerId, scopes) {
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSessions")
      const provider = getProvider(providerId)
      if (!provider) throw new Error(`No auth provider registered for id "${providerId}"`)
      const sessions = await provider.getSessions(scopes, { silent: true })
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSessions")
      if (sessions.length) enforceConsumerTokenReadPolicy(pluginId, providerId, tokenReadPolicy)
      return sessions
    },
    onDidChangeSessions(listener, providerId) {
      requirePermission(hasPermission, "auth:consume", "ctx.auth.onDidChangeSessions")
      return registryOnDidChange((event) => {
        if (
          !hasPermission("auth:consume") ||
          (providerId !== undefined && event.providerId !== providerId)
        )
          return
        const metadata = (session: PluginAuthSessionMetadata): PluginAuthSessionMetadata => ({
          id: session.id,
          account: { id: session.account.id, label: session.account.label },
          scopes: [...session.scopes],
        })
        listener({
          providerId: event.providerId,
          added: event.added.map(metadata),
          removed: event.removed.map(metadata),
          changed: event.changed.map(metadata),
        })
      })
    },
    async createPkceFlow(config) {
      requirePermission(hasPermission, "auth:provide", "ctx.auth.createPkceFlow")
      if ("fetchImpl" in config) {
        throw new Error(
          "ctx.auth.createPkceFlow does not allow fetchImpl; use the host-governed transport."
        )
      }
      config = {
        ...config,
        scopes: [...config.scopes],
        extraAuthParams: { ...config.extraAuthParams },
      }
      requirePermission(hasPermission, "network:fetch", "ctx.auth.createPkceFlow")
      const { network } = options
      if (!network)
        throw new Error("ctx.auth.createPkceFlow requires the host-governed network transport.")
      // Snapshot once so callbacks cannot change which fields the host builds
      // versus those a plugin overrides while authorization is in flight.
      const extraTokenParams = { ...config.extraTokenParams }
      const { tokenRequestEncoding, signal, tokenUrl } = config
      const exemptKeys = new Set(
        ["grant_type", "code", "redirect_uri", "client_id", "code_verifier"].filter(
          (key) => !Object.hasOwn(extraTokenParams, key)
        )
      )
      // A confidential client's secret (RFC 6749 §2.3.1) is a credential, not
      // user text, on the same footing as the gate's CREDENTIAL_KEYS. Every
      // other plugin-supplied extra token parameter stays inspected.
      if (typeof extraTokenParams.client_secret === "string") exemptKeys.add("client_secret")
      // The helper is owned by this plugin; its unchanged public config has no
      // provider id. Bind the attempt to that owner and the exact client/issuer.
      const binding = {
        providerId: pluginId,
        clientId: config.clientId,
        issuer: new URL(config.authorizeUrl).origin,
      }
      const attempt = await createAttempt({
        ...binding,
        method: "oauth-pkce",
        redirectUri: config.redirectUri,
        scopes: config.scopes,
      })
      const waiter = registerAuthCallbackWaiter(attempt.state, binding, attempt.expiresAt)
      // openUrl may fail before the callback driver is entered.
      void waiter.promise.catch(() => {})
      const abort = () => {
        void waiter.cancel().catch(() => {})
      }
      signal?.addEventListener("abort", abort, { once: true })
      const provenance = {}
      hostPkceTokenRequests.set(provenance, {
        tokenUrl,
        keys: Object.freeze([...exemptKeys]),
      })
      if (signal?.aborted) abort()
      const result = await runPkceAuthFlow(
        {
          ...config,
          tokenUrl,
          extraTokenParams,
          openUrl: (url) => {
            signal?.throwIfAborted()
            return config.openUrl(url)
          },
          extraAuthParams: Object.fromEntries(
            Object.entries(config.extraAuthParams ?? {}).filter(
              ([key]) =>
                ![
                  "state",
                  "client_id",
                  "redirect_uri",
                  "code_challenge",
                  "code_challenge_method",
                  "response_type",
                ].includes(key)
            )
          ),
          waitForCode: async (params) => {
            const driver = Promise.resolve()
              .then(() => config.waitForCode(params))
              .then(async (callback) => {
                if (callback.state !== attempt.state)
                  throw new Error("OAuth state mismatch — possible CSRF; aborting")
                await acceptCallback(callback, "pkce-driver")
                return waiter.promise
              })
            const accepted = await Promise.race([waiter.promise, driver])
            if (accepted.callback.error)
              throw new Error(`OAuth authorization failed: ${accepted.callback.error}`)
            if (!accepted.callback.code) throw new Error("OAuth callback missing code")
            return { code: accepted.callback.code, state: accepted.callback.state }
          },
          fetchImpl: async (input, init) => {
            requirePermission(hasPermission, "auth:provide", "ctx.auth.createPkceFlow")
            requirePermission(hasPermission, "network:fetch", "ctx.auth.createPkceFlow")
            signal?.throwIfAborted()
            const request = {
              method: "POST" as const,
              headers: Object.fromEntries(new Headers(init?.headers).entries()),
              body: tokenRequestEncoding === "json" ? JSON.parse(init?.body as string) : init?.body,
              signal,
              [HOST_PKCE_TOKEN_REQUEST]: provenance,
            }
            const response = await network.fetch(String(input), request)
            return new Response(
              typeof response.data === "string" ? response.data : JSON.stringify(response.data),
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              }
            )
          },
        },
        {
          state: attempt.state,
          codeVerifier: attempt.codeVerifier!,
          codeChallenge: attempt.codeChallenge!,
        }
      ).finally(async () => {
        hostPkceTokenRequests.delete(provenance)
        signal?.removeEventListener("abort", abort)
        await waiter.cancel().catch(() => console.warn("Auth callback cleanup failed"))
      })
      requirePermission(hasPermission, "auth:provide", "ctx.auth.createPkceFlow")
      requirePermission(hasPermission, "network:fetch", "ctx.auth.createPkceFlow")
      return result
    },
  }
}
