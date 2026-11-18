"use client"

/**
 * What the phone's Sites overview shows beyond the rail's two signals: the
 * version each live deployment serves, and what each Site did last.
 *
 * The console's index query (`use-site-live-data`) carries every Site and the
 * active deployments, which is enough for a name, a lifecycle and a URL. A
 * phone has no detail pane to open, so the overview answers "which version is
 * in production, and did the last deploy work" on the row itself. Two
 * index-backed reads, kept out of the index query so the desktop rail does not
 * re-read them on every version or operation write.
 */
import { useMemo } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { listRecentSiteOperations, listSiteVersionsByIds } from "@/lib/db/sites"
import type { SiteDeploymentRow, SiteOperationRow, SiteVersionRow } from "@/types/sites"

/** How many operations a phone row lists. */
export const SITE_OVERVIEW_OPERATIONS_PER_SITE = 3

/**
 * How many recent operations the overview reads across every Site. Enough for
 * a handful of Sites to show their last few each without reading a journal
 * that grows with every build.
 */
export const SITE_OVERVIEW_RECENT_OPERATIONS = 50

export interface SiteOverviewDetails {
  /** The version each active deployment serves, by version id. */
  versionsById: ReadonlyMap<string, SiteVersionRow>
  /** Each Site's newest operations, newest first. */
  operationsBySite: ReadonlyMap<string, readonly SiteOperationRow[]>
}

interface Snapshot {
  versions: SiteVersionRow[]
  operations: SiteOperationRow[]
}

const EMPTY: Snapshot = { versions: [], operations: [] }

/** Group newest-first operations by Site, keeping at most `perSite` each. */
export function groupRecentOperations(
  operations: readonly SiteOperationRow[],
  perSite: number = SITE_OVERVIEW_OPERATIONS_PER_SITE
): Map<string, SiteOperationRow[]> {
  const bySite = new Map<string, SiteOperationRow[]>()
  for (const operation of operations) {
    const rows = bySite.get(operation.siteId) ?? []
    if (rows.length >= perSite) continue
    rows.push(operation)
    bySite.set(operation.siteId, rows)
  }
  return bySite
}

export function useSiteOverviewDetails(
  activeDeployments: readonly SiteDeploymentRow[]
): SiteOverviewDetails {
  const versionIds = useMemo(
    () => [...new Set(activeDeployments.map((row) => row.versionId))].sort(),
    [activeDeployments]
  )
  // Keyed on the ids, not the array: the index query hands a new array on
  // every write, and the versions only change when a deployment moves.
  const key = versionIds.join("\n")
  const snapshot = useClientLiveQuery<Snapshot>(
    async () => {
      const [versions, operations] = await Promise.all([
        listSiteVersionsByIds(key ? key.split("\n") : []),
        listRecentSiteOperations(SITE_OVERVIEW_RECENT_OPERATIONS),
      ])
      return { versions, operations }
    },
    [key],
    EMPTY
  )
  const resolved = snapshot ?? EMPTY
  return useMemo(
    () => ({
      versionsById: new Map(resolved.versions.map((row) => [row.id, row])),
      operationsBySite: groupRecentOperations(resolved.operations),
    }),
    [resolved]
  )
}
