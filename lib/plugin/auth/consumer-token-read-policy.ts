import { loggers } from "@cognia/logging"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { getAuthProviderOwner } from "./auth-provider-registry"

/** Under deny, non-provider token reads throw ConsumerTokenReadDenied; no session is returned. */
export type ConsumerTokenReadPolicy = "allow-with-audit" | "deny"

/** Flips to deny next release (ADR-0246 §3); this release preserves tokens with audit. */
export const DEFAULT_CONSUMER_TOKEN_READ_POLICY: ConsumerTokenReadPolicy = "allow-with-audit"

export class ConsumerTokenReadDenied extends Error {
  constructor(
    readonly consumerPluginId: string,
    readonly providerId: string
  ) {
    super("Consumer token reads are denied; use a granted connection through ctx.integrations")
    this.name = "ConsumerTokenReadDenied"
  }
}

const warned = new Set<string>()

/** Host policy, separate from public session options so consumers cannot override it. */
export function enforceConsumerTokenReadPolicy(
  pluginId: string,
  providerId: string,
  policy: ConsumerTokenReadPolicy = DEFAULT_CONSUMER_TOKEN_READ_POLICY
): void {
  if (getAuthProviderOwner(providerId) === pluginId) return
  if (policy === "deny") throw new ConsumerTokenReadDenied(pluginId, providerId)
  // Same audit sink as the ES-05 observe path. Record identifiers, never sessions or tokens.
  getPermissionGuard().recordUsage(
    pluginId,
    "auth:consume",
    `consumer-token-read provider:${providerId}`
  )
  const key = JSON.stringify([pluginId, providerId])
  if (warned.has(key)) return
  warned.add(key)
  loggers.plugin.warn(
    `[${pluginId}] Reading another provider's tokens is transitional; use a granted connection through ctx.integrations. Consumer token reads will be denied next release.`,
    { pluginId, providerId }
  )
}
