/**
 * `ctx.auth` — native auth/OAuth provider API (C1).
 *
 * Promotes the previously VS-Code-only `auth-provider-registry` into a
 * first-class native plugin surface: a plugin can REGISTER an authentication
 * provider (`auth:provide`) and CONSUME sessions from any provider
 * (`auth:consume`), with tokens persisted via `ctx.secrets`. A PKCE helper
 * (`createPkceFlow`) wraps the reusable OAuth flow so a provider's
 * `createSession` doesn't hand-roll crypto. Like VS Code `authentication` +
 * Raycast OAuth / `withAccessToken`.
 */

import {
  registerAuthenticationProvider,
  getSession as registryGetSession,
  getProvider,
  onDidChangeSessions as registryOnDidChange,
} from "@/lib/plugin/auth/auth-provider-registry"
import { runPkceAuthFlow } from "@/lib/plugin/auth/auth-pkce-flow"
import type {
  CreateAuthAPIOptions,
  PluginAuthAPI,
  PluginAuthSessionMetadata,
} from "@cognia/plugin-contract/lib/plugin/api/auth-api"
export type {
  CreateAuthAPIOptions,
  PluginAuthAPI,
  PluginAuthProvider,
} from "@cognia/plugin-contract/lib/plugin/api/auth-api"

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

export function createAuthAPI(pluginId: string, options: CreateAuthAPIOptions): PluginAuthAPI {
  const { hasPermission } = options
  return {
    registerProvider(provider) {
      requirePermission(hasPermission, "auth:provide", "ctx.auth.registerProvider")
      return registerAuthenticationProvider({ ...provider, pluginId })
    },
    async getSession(providerId, scopes, sessionOptions) {
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSession")
      const session = await registryGetSession(providerId, scopes, sessionOptions)
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSession")
      return session
    },
    async getSessions(providerId, scopes) {
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSessions")
      const provider = getProvider(providerId)
      if (!provider) throw new Error(`No auth provider registered for id "${providerId}"`)
      const sessions = await provider.getSessions(scopes, { silent: true })
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSessions")
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
      requirePermission(hasPermission, "network:fetch", "ctx.auth.createPkceFlow")
      const { network } = options
      if (!network)
        throw new Error("ctx.auth.createPkceFlow requires the host-governed network transport.")
      const result = await runPkceAuthFlow({
        ...config,
        fetchImpl: async (input, init) => {
          requirePermission(hasPermission, "auth:provide", "ctx.auth.createPkceFlow")
          requirePermission(hasPermission, "network:fetch", "ctx.auth.createPkceFlow")
          const response = await network.fetch(String(input), {
            method: "POST",
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body:
              config.tokenRequestEncoding === "json"
                ? JSON.parse(init?.body as string)
                : init?.body,
            signal: config.signal,
          })
          return new Response(
            typeof response.data === "string" ? response.data : JSON.stringify(response.data),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }
          )
        },
      })
      requirePermission(hasPermission, "auth:provide", "ctx.auth.createPkceFlow")
      requirePermission(hasPermission, "network:fetch", "ctx.auth.createPkceFlow")
      return result
    },
  }
}
