import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getDb } from "@/lib/db/schema"
import { queueAccessTeardown, runAccessTeardown } from "@/lib/external-services/access-teardown"

/** Host-only removal, atomic across projected grants and the saved account selection. */
export async function revokeConsumerAccess(
  ref: AuthConnectionRef,
  consumerPluginId: string,
  options: { removeAccounts?: boolean } = {}
): Promise<void> {
  const db = getDb()
  const target = { kind: "consumer" as const, ref, consumerPluginId }
  await db.transaction(
    "rw",
    [
      db.integrationAccounts,
      db.serviceConnections,
      db.capabilityGrants,
      db.connectionBindings,
      db.integrationAudit,
    ],
    async () => {
      const accounts = await db.integrationAccounts
        .filter((row) => row.connectionId === ref)
        .toArray()
      const accountIds = new Set(accounts.map((row) => row.id))
      const projections = await db.serviceConnections
        .filter(
          (row) =>
            row.providerRef.kind === "integration" &&
            (row.providerRef.authConnectionRef === ref || accountIds.has(row.providerRef.accountId))
        )
        .toArray()
      const projectionIds = new Set(projections.map((row) => row.id))
      await db.capabilityGrants
        .filter(
          (row) =>
            row.consumerPluginId === consumerPluginId &&
            (projectionIds.has(row.connectionId) ||
              (row.accountId !== undefined && accountIds.has(row.accountId)))
        )
        .delete()
      await db.connectionBindings
        .where("connectionRef")
        .equals(ref)
        .filter((row) => row.consumerPluginId === consumerPluginId)
        .delete()
      await queueAccessTeardown(target, options)
    }
  )
  await runAccessTeardown(target)
}
