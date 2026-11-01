import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getDb } from "./schema"
import { hasPendingConnectionCleanup } from "./external-services"

/** One account-local, device-local selection per consumer and provider. */
export interface ConnectionBindingRow {
  consumerPluginId: string
  providerId: string
  connectionRef: AuthConnectionRef
  createdAt: number
  updatedAt: number
}

export function getConnectionBinding(consumerPluginId: string, providerId: string) {
  return getDb().connectionBindings.get([consumerPluginId, providerId])
}

export async function putConnectionBinding(
  consumerPluginId: string,
  providerId: string,
  connectionRef: AuthConnectionRef,
  expectedRevision?: number
): Promise<boolean> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.connectionBindings,
    db.authConnections,
    db.integrationAudit,
    async () => {
      if (await hasPendingConnectionCleanup(connectionRef, consumerPluginId)) return false
      // The selector supplies its revision. This shares the disconnect writer's
      // tables, so it cannot recreate a binding after a terminal state commits.
      if (expectedRevision !== undefined) {
        const connection = await db.authConnections.get(connectionRef)
        if (
          !connection ||
          connection.status !== "connected" ||
          connection.providerId !== providerId ||
          connection.revision !== expectedRevision
        )
          return false
      }
      const existing = await getConnectionBinding(consumerPluginId, providerId)
      const now = Date.now()
      await db.connectionBindings.put({
        consumerPluginId,
        providerId,
        connectionRef,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      return true
    }
  )
}

export async function removeConnectionBinding(
  consumerPluginId: string,
  providerId: string
): Promise<void> {
  await getDb().connectionBindings.delete([consumerPluginId, providerId])
}

export function listConnectionBindings(consumerPluginId: string) {
  return getDb()
    .connectionBindings.filter((row) => row.consumerPluginId === consumerPluginId)
    .toArray()
}
