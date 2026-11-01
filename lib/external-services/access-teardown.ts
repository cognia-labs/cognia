import { getDb } from "@/lib/db/schema"
import { getIntegrationIngressEndpoint } from "@/lib/db/integrations"
import { withAuthLock } from "@/lib/plugin/auth/connection-credentials"
import {
  listDerivedDataAccounts,
  purgeDerivedData,
  type DerivedDataTarget,
  type DerivedDataPurgeReport,
} from "./derived-data-registry"

const PENDING = "access.cleanup.pending"
const cleanupId = (target: DerivedDataTarget) => `host-access-cleanup:${JSON.stringify(target)}`

/** Call in the same transaction as the terminal/grant change. No credential material. */
export async function queueAccessTeardown(
  target: DerivedDataTarget,
  options: { removeAccounts?: boolean } = {}
): Promise<void> {
  const previous = await getDb().integrationAudit.get(cleanupId(target))
  await getDb().integrationAudit.put({
    id: cleanupId(target),
    pluginId:
      target.kind === "plugin-data"
        ? target.pluginId
        : target.kind === "consumer"
          ? target.consumerPluginId
          : "__host__",
    integrationId: "__host__",
    kind: PENDING,
    outcome: "succeeded",
    detail: {
      target,
      generation: crypto.randomUUID(),
      removeAccounts: options.removeAccounts || previous?.detail?.removeAccounts === true,
    },
    createdAt: new Date().toISOString(),
  })
}

/** Retriable Host cleanup, after access is gone. Every independent step runs. */
export async function runAccessTeardown(
  target: DerivedDataTarget
): Promise<DerivedDataPurgeReport> {
  return withAuthLock(
    `cognia-access-cleanup:${cleanupId(target)}`,
    () => runQueuedTeardown(target),
    "access-cleanup"
  )
}

async function runQueuedTeardown(target: DerivedDataTarget): Promise<DerivedDataPurgeReport> {
  const db = getDb()
  const queued = await db.integrationAudit.get(cleanupId(target))
  const report: DerivedDataPurgeReport = { purged: [], failed: [] }
  // Another window may have completed it while this caller waited for the
  // lock. Never let a stale invocation erase a freshly consented generation.
  if (!queued) return report
  const step = async (id: string, task: () => Promise<unknown>) => {
    try {
      await task()
      report.purged.push(id)
    } catch {
      report.failed.push(id)
    }
  }
  if (target.kind !== "plugin-data") {
    await step("integration-background", async () => {
      // Migrate legacy endpoint fields before deleting subscriptions/cursors.
      for (const account of await listDerivedDataAccounts(target)) {
        const endpoint =
          account.ingressEndpoint ??
          (await getIntegrationIngressEndpoint(account.pluginId, account.id))
        await db.integrationAccounts.update(account.id, {
          enabled: false,
          ...(endpoint ? { ingressEndpoint: { ...endpoint, enabled: false } } : {}),
        })
      }
      const accounts = await listDerivedDataAccounts(target)
      await db.integrationSubscriptions
        .where("accountId")
        .anyOf(accounts.map((account) => account.id))
        .delete()
    })
    await step("integration-actions", async () => {
      const { cancelIntegrationActionJobsForAccounts } =
        await import("@/lib/integrations/action-runner")
      await cancelIntegrationActionJobsForAccounts(
        (await listDerivedDataAccounts(target)).map((account) => account.id)
      )
    })
    await step("connection-bindings", async () => {
      await db.connectionBindings
        .where("connectionRef")
        .equals(target.ref)
        .filter(
          (row) => target.kind === "connection" || row.consumerPluginId === target.consumerPluginId
        )
        .delete()
    })
  }
  const purge = await purgeDerivedData(target)
  report.purged.push(...purge.purged)
  report.failed.push(...purge.failed)
  if (report.failed.length === 0 && target.kind !== "plugin-data") {
    await step("integration-cursors", async () => {
      for (const account of await listDerivedDataAccounts(target))
        await db.integrationAccounts.update(account.id, { ingressEndpoint: undefined })
    })
  }
  if (report.failed.length === 0 && queued?.detail?.removeAccounts === true) {
    await step("integration-accounts", async () => {
      const { deleteIntegrationAccount } = await import("@/lib/integrations/ingress-client")
      for (const account of await listDerivedDataAccounts(target))
        await deleteIntegrationAccount(account.pluginId, account.id)
    })
  }
  if (report.failed.length === 0 && queued) {
    await db.transaction("rw", db.integrationAudit, async () => {
      const current = await db.integrationAudit.get(queued.id)
      if (current?.detail?.generation === queued.detail?.generation)
        await db.integrationAudit.delete(queued.id)
    })
  }
  return report
}

/** Startup retries local cleanup only; it never calls a vendor or revokes again. */
export async function sweepAccessTeardowns(): Promise<void> {
  for (const row of await getDb().integrationAudit.where("kind").equals(PENDING).toArray()) {
    try {
      await runAccessTeardown(row.detail!.target as DerivedDataTarget)
    } catch {
      console.warn("Auth access cleanup retry failed")
    }
  }
}
