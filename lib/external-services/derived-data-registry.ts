import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getDb } from "@/lib/db/schema"
import { withNamedLock } from "@/lib/locks/named-lock"
import type { ExternalSyncTarget } from "./sync/types"
import type { GithubMirrorSyncOwnership } from "@/lib/issues/github-sync"

/**
 * Host-derived data only. Twin imports and Issue Sync imports are user-kept
 * copies, including chunks, vectors and retrieval generations built from the
 * local Twin copy. Keep their provenance and show source availability instead
 * of deleting them. The GitHub issue mirror is a rebuildable remote cache and
 * is purged by its own row ownership, independently of disposable cursors.
 * Remote document reads, document search results and link previews are not
 * persisted (memory only), so they need no purger.
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

async function purgeExternalSync(target: DerivedDataTarget, mirrorOnly = false) {
  const db = getDb()
  const matches = (row: ExternalSyncTarget & GithubMirrorSyncOwnership) =>
    (!mirrorOnly || row.key.startsWith("github-mirror:")) &&
    (target.kind === "plugin-data"
      ? row.owner === `plugin:${target.pluginId}` ||
        (row.key.startsWith("github-mirror:") &&
          (row.consumerPluginId === target.pluginId || row.providerPluginId === target.pluginId))
      : row.connectionRef === target.ref &&
        (target.kind === "connection" ||
          row.owner === `plugin:${target.consumerPluginId}` ||
          (row.key.startsWith("github-mirror:") &&
            row.consumerPluginId === target.consumerPluginId)))
  const { unregisterExternalSync, unregisterExternalSyncTargets } = await import("./sync/runtime")
  // Cancel timers and unresolved factories even before they have a cursor row.
  unregisterExternalSyncTargets(matches)
  const barrierId = `external-sync-purge:${JSON.stringify(target)}${mirrorOnly ? ":github-mirror" : ""}`
  let rows: ExternalSyncTarget[] = []
  const { deleteExternalSyncRenewalTask, syncExternalSyncRenewalSchedule } =
    await import("./sync/renewal")
  const generation = crypto.randomUUID()
  await db.transaction(
    "rw",
    db.externalSyncCursors,
    db.externalSyncSeen,
    db.integrationAudit,
    async () => {
      const previous = await db.integrationAudit.get(barrierId)
      const current = await db.externalSyncCursors.filter(matches).toArray()
      rows = [
        ...((previous?.detail?.targets as ExternalSyncTarget[] | undefined) ?? []),
        ...current.map(({ key, owner, connectionRef }) => ({ key, owner, connectionRef })),
      ]
      const keys = new Set(current.map((row) => row.key))
      if (!rows.length) return
      // Retain the exclusion keys across a timeout/restart even though the
      // cursors are gone. Access teardown retries must still wait for them.
      await db.integrationAudit.put({
        id: barrierId,
        pluginId: target.kind === "plugin-data" ? target.pluginId : "__host__",
        integrationId: "__host__",
        kind: "external-sync.purge.pending",
        outcome: "succeeded",
        detail: { targets: rows, generation },
        createdAt: new Date().toISOString(),
      })
      await db.externalSyncSeen.filter((row) => keys.has(row.key)).delete()
      await db.externalSyncCursors.bulkDelete([...keys])
    }
  )
  for (const row of rows) {
    unregisterExternalSync(row.key)
    await deleteExternalSyncRenewalTask(row.key)
    if (row.connectionRef) {
      // Core leases last 30 s; allow a margin, but never wait indefinitely
      // for a runtime that keeps renewing without reaching its next commit.
      const deadline = Date.now() + 35_000
      while (true) {
        const lease = await db.syncLeases.get(`${row.connectionRef}:sync:${row.key}`)
        if (!lease || lease.expiresAt <= Date.now()) break
        if (Date.now() >= deadline) throw new Error("External sync purge timed out")
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } else {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        // Web Locks do not apply withNamedLock's fallback waitMs. Bound the
        // caller too; a late lock callback only acquires and releases it.
        await Promise.race([
          withNamedLock(`cognia-external-sync:${row.key}`, async () => undefined, {
            waitMs: 5000,
            ...(typeof window === "undefined" ? { mode: "in-process" as const } : {}),
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("External sync purge timed out")), 5000)
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    }
  }
  if (rows.length) await syncExternalSyncRenewalSchedule()
  await db.transaction("rw", db.integrationAudit, async () => {
    const barrier = await db.integrationAudit.get(barrierId)
    if (barrier?.detail?.generation === generation) await db.integrationAudit.delete(barrierId)
  })
  // A runtime whose plugin is still active may start a fresh full sync after
  // a plugin-data purge. That is expected; this barrier drains stale runs.
}

registerDerivedDataPurger({
  id: "external-sync",
  purge: (target) => purgeExternalSync(target),
})

registerDerivedDataPurger({
  id: "github-issue-mirror",
  async purge(target) {
    await getDb().integrationAudit.put({
      id: `github-mirror-purge:${JSON.stringify(target)}`,
      pluginId: target.kind === "plugin-data" ? target.pluginId : "__host__",
      integrationId: "__host__",
      kind: "github-mirror.purge",
      outcome: "succeeded",
      detail: { target, generation: crypto.randomUUID() },
      createdAt: new Date().toISOString(),
    })
    // Drain resolved runs even if the earlier purger ran before their factory settled.
    await purgeExternalSync(target, true)
    await getDb()
      .githubIssueMirror.filter((row) =>
        target.kind === "plugin-data"
          ? row.consumerPluginId === target.pluginId || row.providerPluginId === target.pluginId
          : row.connectionRef === target.ref &&
            (target.kind === "connection" || row.consumerPluginId === target.consumerPluginId)
      )
      .delete()
  },
})
