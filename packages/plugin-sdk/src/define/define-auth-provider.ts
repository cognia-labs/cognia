/**
 * Plugin SDK helper for native auth/OAuth providers (C1).
 *
 * Pure typesafety pass-through for the provider object a plugin registers via
 * `ctx.auth.registerProvider(...)`. The matching `manifest.authProviders[]`
 * entry declares the id, label and supported methods/principals and needs no helper.
 * The Host decides when to authorize, exchange, refresh, revoke or describe credentials
 * (ADR-0246 §5). The provider never schedules refresh itself.
 *
 * Usage:
 *   // manifest.authProviders[] declares authorization: { clientId, issuer }.
 *   ctx.auth.registerProvider(defineAuthProvider({
 *     management: "host",
 *     id: "acme",
 *     label: "Acme",
 *     // Use attempt.attemptId as state and attempt.codeChallenge with S256.
 *     // The Host chooses redirectUri and opens the returned HTTPS URL.
 *     authorize: (attempt) => acme.authorizationUrl(attempt),
 *     exchange: (attempt, callback) => acme.exchange(attempt, callback),
 *     refresh: (lineage) => acme.refresh(lineage.credentials),
 *     describe: (credentials) => acme.describeIdentity(credentials),
 *   }))
 */

import type { PluginAuthProvider } from "@cognia/plugin-contract/lib/plugin/api/auth-api"

export function defineAuthProvider<T extends PluginAuthProvider>(provider: T): T {
  return provider
}
