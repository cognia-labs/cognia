"use client"

/**
 * Every source's issues for one workspace, live.
 *
 * The board used to take a snapshot from `listAll` and re-take it whenever a
 * local issue's `updatedAt` changed, plus a manual tick after a sync or a
 * GitHub write-back. Anything that changed only a federated row (an Agent
 * Team task moving, a collaboration pull, a mirror refresh it did not start)
 * stayed stale until a local edit happened to come along. This follows
 * `IssueSourceRegistry.subscribeAll` instead, so each source's own change
 * signal reaches the board.
 *
 * `ready` is false until every source has answered for the current query, so
 * a caller can tell "nothing here" from "not read yet". Changing the query
 * drops the previous rows at once rather than showing them under the new one.
 */

import { useEffect, useMemo, useState } from "react"

import {
  getIssueSourceRegistry,
  type IssueSourceRegistry,
  type IssueSourceSnapshot,
} from "@/lib/issues/sources/registry"
import type { UnifiedIssueItem } from "@/types/issues/unified"

export interface UnifiedIssuesState {
  items: UnifiedIssueItem[]
  errors: IssueSourceSnapshot["errors"]
  ready: boolean
}

const EMPTY: UnifiedIssuesState = Object.freeze({ items: [], errors: [], ready: false })

/** `projectId` undefined means no workspace is open: nothing is read. */
export function useUnifiedIssues(
  projectId: string | undefined,
  issueProjectId?: string,
  registry: IssueSourceRegistry = getIssueSourceRegistry()
): UnifiedIssuesState {
  const key = projectId ? `${projectId}\u0000${issueProjectId ?? ""}` : undefined
  const [delivered, setDelivered] = useState<{
    key: string
    snapshot: IssueSourceSnapshot
    registry: IssueSourceRegistry
  }>()

  useEffect(() => {
    if (!projectId || !key) return
    return registry.subscribeAll(
      { projectId, ...(issueProjectId ? { issueProjectId } : {}) },
      (snapshot) => setDelivered({ key, snapshot, registry })
    )
  }, [key, projectId, issueProjectId, registry])

  return useMemo(() => {
    if (!key || !delivered || delivered.key !== key || delivered.registry !== registry) return EMPTY
    return { items: delivered.snapshot.items, errors: delivered.snapshot.errors, ready: true }
  }, [key, delivered, registry])
}
