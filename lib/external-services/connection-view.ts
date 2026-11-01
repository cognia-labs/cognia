import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import type { CapabilityGrant, ServiceConnection } from "@/types/external-service"
import type { PluginIntegrationDef } from "@/types/plugin/plugin-integration"
import type { AuthenticationProvider } from "@/lib/plugin/auth/auth-provider-registry"
import { getHostConnectionDriver } from "@/lib/plugin/auth/connection-manager"

export interface ConsumerGrantView {
  id: string
  revision?: number
  needsReapproval: boolean
  readOperations: string[]
  writeOperations: string[]
}
export interface ConnectionView {
  connection: AuthConnectionRow
  providerLabel: string
  canReconnect: boolean
  consumers: Array<{ pluginId: string; name: string; grants: ConsumerGrantView[] }>
}

/** Host connections are the primary rows; service connections are account projections only. */
export function buildConnectionViews(
  connections: readonly AuthConnectionRow[],
  projections: readonly ServiceConnection[],
  grants: readonly CapabilityGrant[],
  providers: readonly AuthenticationProvider[],
  plugins: readonly { id: string; manifest: { name?: unknown } }[],
  integrations: readonly { pluginId: string; definition: PluginIntegrationDef }[],
  now = new Date().toISOString()
): ConnectionView[] {
  return connections
    .filter((row) => row.status !== "revoked" && row.status !== "tombstoned")
    .map((connection) => {
      const provider = providers.find(
        (item) => item.id === connection.providerId && item.pluginId === connection.ownerPluginId
      )
      const projectionIds = new Set(
        projections
          .filter(
            (row) =>
              row.providerRef.kind === "integration" &&
              row.providerRef.authConnectionRef === connection.id
          )
          .map((row) => row.id)
      )
      const consumers = new Map<string, ConnectionView["consumers"][number]>()
      for (const grant of grants) {
        if (
          !grant.consumerPluginId ||
          !projectionIds.has(grant.connectionId) ||
          (grant.expiresAt !== undefined && grant.expiresAt <= now)
        )
          continue
        const pluginId = grant.consumerPluginId
        let consumer = consumers.get(pluginId)
        if (!consumer) {
          const name = plugins.find((plugin) => plugin.id === pluginId)?.manifest.name
          consumer = { pluginId, name: typeof name === "string" ? name : pluginId, grants: [] }
          consumers.set(pluginId, consumer)
        }
        const isRead = (operation: string) => {
          const definitions = integrations
            .filter((item) => item.pluginId === pluginId)
            .map((item) => item.definition)
          const actions = definitions.flatMap((definition) =>
            definition.actions.filter(
              (action) => (action.operationId ?? `${definition.id}.${action.id}`) === operation
            )
          )
          if (actions.length) return actions.every((action) => action.risk === "read")
          return definitions.some((definition) =>
            ["GET", "HEAD", "OPTIONS"].some(
              (method) => operation === `${definition.id}.request.${method}`
            )
          )
        }
        consumer.grants.push({
          id: grant.id,
          revision: grant.connectionRevision,
          needsReapproval: grant.connectionRevision !== connection.revision,
          readOperations: grant.operationPatterns.filter(isRead),
          // Unknown/wildcard operations are conservatively displayed with writes.
          writeOperations: grant.operationPatterns.filter((operation) => !isRead(operation)),
        })
      }
      return {
        connection,
        providerLabel: provider?.label ?? connection.providerId,
        canReconnect:
          Boolean(
            provider?.describe ||
            (provider?.pluginId === null && getHostConnectionDriver(provider.id)?.reauthorize)
          ) &&
          (connection.status === "needs-reauth" || connection.status === "provider-unavailable"),
        consumers: [...consumers.values()].sort((a, b) => a.name.localeCompare(b.name)),
      }
    })
}
