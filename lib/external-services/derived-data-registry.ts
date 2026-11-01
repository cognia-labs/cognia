import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getDb } from "@/lib/db/schema"

/**
 * Host-derived data only; never user-kept attachments, messages or artifacts.
 * Docs caches, Twin chunks, link previews and the GitHub mirror have no
 * connection provenance today. P5/P6/P7 must bind them before adding purgers.
 * Integration resources are fetched on demand; there is no persisted resource
 * cache today. The registered id set is deliberately pinned by a test.
 */
export type DerivedDataTarget =
  | { kind: "connection"; ref: AuthConnectionRef }
  | { kind: "consumer"; ref: AuthConnectionRef; consumerPluginId: string }
  | { kind: "plugin-data"; pluginId: string }

export interface DerivedDataPurgeReport {
  purged: string[]
  failed: string[]
}

interface DerivedDataPurger {
  id: string
  purge(target: DerivedDataTarget): Promise<unknown>
}

const purgers = new Map<string, DerivedDataPurger>()

export function registerDerivedDataPurger(purger: DerivedDataPurger): () => void {
  if (purgers.has(purger.id)) throw new Error("Derived data purger already registered")
  purgers.set(purger.id, purger)
  return () => {
    if (purgers.get(purger.id) === purger) purgers.delete(purger.id)
  }
}

export function listDerivedDataPurgerIds(): string[] {
  return [...purgers.keys()]
}

/** Each purger runs even if another fails. Reports contain ids, never errors or secrets. */
export async function purgeDerivedData(target: DerivedDataTarget): Promise<DerivedDataPurgeReport> {
  const report: DerivedDataPurgeReport = { purged: [], failed: [] }
  for (const purger of [...purgers.values()]) {
    try {
      await purger.purge(target)
      report.purged.push(purger.id)
    } catch {
      report.failed.push(purger.id)
    }
  }
  return report
}

export function listDerivedDataAccounts(target: DerivedDataTarget) {
  return getDb()
    .integrationAccounts.filter((account) =>
      target.kind === "plugin-data"
        ? account.pluginId === target.pluginId && account.connectionId !== undefined
        : account.connectionId === target.ref &&
          (target.kind === "connection" || account.pluginId === target.consumerPluginId)
    )
    .toArray()
}

registerDerivedDataPurger({
  id: "integration-events",
  async purge(target) {
    for (const account of await listDerivedDataAccounts(target))
      await getDb().integrationEvents.where("accountId").equals(account.id).delete()
  },
})

registerDerivedDataPurger({
  id: "integration-ingress",
  async purge(target) {
    const { unregisterIngress } = await import("@/lib/integrations/ingress-client")
    const { getIntegrationIngressEndpoint } = await import("@/lib/db/integrations")
    const { createKeyringStore } = await import("@/lib/credentials/keyring-store")
    // Retain endpoint metadata until cleanup succeeds, including legacy routes.
    // Unregister with purge deletes the whole route, not the latest-500 window.
    for (const account of await listDerivedDataAccounts(target)) {
      const endpoint =
        account.ingressEndpoint ??
        (await getIntegrationIngressEndpoint(account.pluginId, account.id))
      if (endpoint) {
        await unregisterIngress(endpoint, { purge: true })
        await createKeyringStore("integration-ingress").delete(endpoint.secretHandle)
      }
    }
  },
})

registerDerivedDataPurger({
  id: "integration-event-audit",
  async purge(target) {
    for (const account of await listDerivedDataAccounts(target))
      await getDb()
        .integrationAudit.where("accountId")
        .equals(account.id)
        .filter((row) => row.kind.startsWith("event."))
        .delete()
    // Keep action/authorization/security records and migration backup/completion
    // records: they prove writes, denied access and rollback, not cached content.
    // access.cleanup.* is also retained until its durable retry completes.
  },
})
