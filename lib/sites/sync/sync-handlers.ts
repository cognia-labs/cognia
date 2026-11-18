/**
 * What the sites module contributes to companion sync (ADR-0250 §14
 * `syncHandlers`): the Host's Cognia Sites, mirrored read-only onto a paired
 * phone or browser (ADR-0084 "Consequences").
 *
 * The desktop authors and deploys. A paired client only reads, so `/sites`
 * there shows the Host's Sites, their lifecycle, the version in production,
 * the live deployment with its entry-point verification, the operation
 * journal and the provider resources, and every control that would change
 * them is closed by the action gate (`hooks/sites/use-site-action-gate.ts`).
 *
 * **What never crosses.** Provider tokens and Site secret values live in the
 * Host's keyring and are in no row: a Site records only whether a token was
 * verified and when, and an environment revision holds non-secret variables
 * plus keyring references. Two tables stay off the wire entirely:
 * `siteBuildLogs` (up to half a megabyte of untrusted build output per
 * version) and `siteArtifacts` (the archive bytes). Each operation crosses
 * without `inputPayload`, the reconcile input only the Host's reconciler
 * reads, and without `leaseOwner`, the Host process that holds it.
 *
 * **Cursors.** Every reader advances on the field each writer in
 * `lib/db/sites.ts` actually moves:
 *
 *  - `siteProjects`: `updatedAt`, and the provider-token state's
 *    `verifiedAt` / `lastFailureAt`. `setSiteProviderTokenState` deliberately
 *    leaves `updatedAt` alone (a credential check must not reorder the list),
 *    so an `updatedAt` cursor alone would never carry "token verified".
 *  - `siteVersions`: the newest of `createdAt`, `completedAt` and
 *    `artifactCollectedAt`. A version has no `updatedAt`; it is drafted,
 *    completed or failed once, and the artifact sweep marks it collected.
 *  - `siteEnvironmentRevisions`, `siteOperationEvents`: `createdAt`, through
 *    its index. Both are append-only.
 *  - `siteDeployments`: `updatedAt`, through its index.
 *  - `siteOperations`, `siteResources`: `updatedAt`, which every writer
 *    stamps but no index covers.
 *
 * The readers without an index scan the table. Each holds a person's own
 * Sites and their journal, not a feed, and a pull runs when the table changed
 * or the client foregrounds, so the scan stays cheap; an index would need a
 * schema bump for no measurable gain.
 *
 * **Deletions.** `deleteSiteProjectMetadata` is the only path that deletes
 * these rows, and it tombstones every one inside its transaction, so the
 * shared `finalizeDelta` folds them into `deleted_ids`.
 */

import type { Table } from "dexie"

import { getDb } from "@/lib/db/schema"
import type { ModuleSyncHandlersModule } from "@/lib/modules/manifest-types"
import { finalizeDelta } from "@/lib/sync/delta"
import { runSyncHandler } from "@/lib/sync/handlers/base"
import type { SyncDelta, SyncPull, SyncableTable } from "@/lib/sync/types"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

/** The Sites tables a paired client mirrors, in the order the console needs them. */
export const SITE_MIRROR_TABLES = [
  "siteProjects",
  "siteVersions",
  "siteEnvironmentRevisions",
  "siteDeployments",
  "siteOperations",
  "siteOperationEvents",
  "siteResources",
] as const satisfies readonly SyncableTable[]

export type SiteMirrorTable = (typeof SITE_MIRROR_TABLES)[number]

/** An operation as it crosses: no reconcile input, no lease holder. */
export type MirroredSiteOperationRow = Omit<SiteOperationRow, "inputPayload" | "leaseOwner">

/* ------------------------------------------------------------------ cursors */

/** A Site's change cursor: its own writes, and the provider-token check. */
export function siteProjectCursor(row: SiteProjectRow): number {
  return Math.max(
    row.updatedAt,
    row.providerTokenState?.verifiedAt ?? 0,
    row.providerTokenState?.lastFailureAt ?? 0
  )
}

/** A version's change cursor: drafted, then completed or failed, then maybe collected. */
export function siteVersionCursor(row: SiteVersionRow): number {
  return Math.max(row.createdAt, row.completedAt ?? 0, row.artifactCollectedAt ?? 0)
}

/** Strip what only the Host's reconciler and lease holder read. */
export function projectSiteOperation(row: SiteOperationRow): MirroredSiteOperationRow {
  const { inputPayload: _inputPayload, leaseOwner: _leaseOwner, ...mirrored } = row
  return mirrored
}

/* ------------------------------------------------------------- host readers */

async function readSiteProjectsDelta(since: number): Promise<SyncDelta<SiteProjectRow>> {
  const rows = (await getDb().siteProjects.toArray()).filter(
    (row) => siteProjectCursor(row) > since
  )
  return finalizeDelta("siteProjects", rows, since, false, siteProjectCursor)
}

async function readSiteVersionsDelta(since: number): Promise<SyncDelta<SiteVersionRow>> {
  const rows = (await getDb().siteVersions.toArray()).filter(
    (row) => siteVersionCursor(row) > since
  )
  return finalizeDelta("siteVersions", rows, since, false, siteVersionCursor)
}

async function readSiteEnvironmentRevisionsDelta(
  since: number
): Promise<SyncDelta<SiteEnvironmentRevisionRow>> {
  const rows = await getDb().siteEnvironmentRevisions.where("createdAt").above(since).toArray()
  return finalizeDelta("siteEnvironmentRevisions", rows, since)
}

async function readSiteDeploymentsDelta(since: number): Promise<SyncDelta<SiteDeploymentRow>> {
  const rows = await getDb().siteDeployments.where("updatedAt").above(since).toArray()
  return finalizeDelta("siteDeployments", rows, since)
}

async function readSiteOperationsDelta(
  since: number
): Promise<SyncDelta<MirroredSiteOperationRow>> {
  const rows = (await getDb().siteOperations.toArray())
    .filter((row) => row.updatedAt > since)
    .map(projectSiteOperation)
  return finalizeDelta("siteOperations", rows, since)
}

async function readSiteOperationEventsDelta(
  since: number
): Promise<SyncDelta<SiteOperationEventRow>> {
  const rows = await getDb().siteOperationEvents.where("createdAt").above(since).toArray()
  return finalizeDelta("siteOperationEvents", rows, since)
}

async function readSiteResourcesDelta(since: number): Promise<SyncDelta<SiteResourceRow>> {
  const rows = (await getDb().siteResources.toArray()).filter((row) => row.updatedAt > since)
  return finalizeDelta("siteResources", rows, since)
}

/* ------------------------------------------------------------ client pulls */

function pullInto<TRow extends { id: string }>(
  table: SiteMirrorTable,
  getTable: () => Table<TRow, string>
): SyncPull {
  return (transport, cursor) => runSyncHandler<TRow>({ table, getTable }, transport, cursor)
}

export const syncHandlers: ModuleSyncHandlersModule["syncHandlers"] = {
  siteProjects: {
    pull: pullInto("siteProjects", () => getDb().siteProjects),
    serve: readSiteProjectsDelta,
  },
  siteVersions: {
    pull: pullInto("siteVersions", () => getDb().siteVersions),
    serve: readSiteVersionsDelta,
  },
  siteEnvironmentRevisions: {
    pull: pullInto("siteEnvironmentRevisions", () => getDb().siteEnvironmentRevisions),
    serve: readSiteEnvironmentRevisionsDelta,
  },
  siteDeployments: {
    pull: pullInto("siteDeployments", () => getDb().siteDeployments),
    serve: readSiteDeploymentsDelta,
  },
  siteOperations: {
    // The mirror stores the projection; the client never reconciles or leases.
    pull: pullInto("siteOperations", () => getDb().siteOperations),
    serve: readSiteOperationsDelta,
  },
  siteOperationEvents: {
    pull: pullInto("siteOperationEvents", () => getDb().siteOperationEvents),
    serve: readSiteOperationEventsDelta,
  },
  siteResources: {
    pull: pullInto("siteResources", () => getDb().siteResources),
    serve: readSiteResourcesDelta,
  },
}
