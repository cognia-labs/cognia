/**
 * Local issue source: projects Dexie `issues` rows into `UnifiedIssueItem`.
 *
 * Read-only as an adapter on purpose. Local issues are written through
 * `lib/issues/service.ts`, the one write door with its validation and run
 * lock (`audit:issue-write-boundary`); `mutate` is for federated sources whose
 * writes go to their own backend.
 */

import type { Issue } from "@/types/issues"
import type { IssueSourceAdapter, IssueSourceQuery, UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, makeUnifiedIssueId } from "@/types/issues/unified"
import { listIssues } from "@/lib/db/issues"
import { observeIssueList } from "./live"
import { getIssueSourceRegistry, type IssueSourceRegistry } from "./registry"

import { issueHref } from "@/lib/issues/hrefs"

// The href lives in `lib/issues/hrefs.ts` so Dexie-free callers can link to an
// issue. Re-exported here because this is where every source-side caller
// already imports it from.
export { issueHref }

/** Project a stored issue into the board's normalized shape. */
export function toUnifiedIssue(issue: Issue): UnifiedIssueItem {
  return {
    unifiedId: makeUnifiedIssueId("local", issue.id),
    kind: "local",
    sourceId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(issue.description ? { description: issue.description } : {}),
    status: issue.status,
    statusCategory: issue.statusCategory,
    priority: issue.priority,
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    createdBy: issue.createdBy,
    labelIds: issue.labelIds,
    issueProjectId: issue.issueProjectId,
    order: issue.order,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    origin: {
      tableName: "issues",
      deepLinkHref: issueHref(issue.id),
    },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...(issue.parentId ? { parentId: issue.parentId } : {}),
    ...(issue.blockedBy?.length ? { blockedBy: issue.blockedBy } : {}),
    ...(issue.dueDate !== undefined ? { dueDate: issue.dueDate } : {}),
    ...(issue.estimate !== undefined ? { estimate: issue.estimate } : {}),
    ...(issue.stage !== undefined ? { stage: issue.stage } : {}),
    ...(issue.triage ? { triage: issue.triage } : {}),
    ...(issue.cycleId ? { cycleId: issue.cycleId } : {}),
    ...(issue.externalRefs?.length ? { externalRefs: issue.externalRefs } : {}),
    ...(issue.origin ? { filedFrom: issue.origin } : {}),
  }
}

async function listLocalIssues(query: IssueSourceQuery): Promise<UnifiedIssueItem[]> {
  const rows = await listIssues({
    projectId: query.projectId,
    ...(query.issueProjectId ? { issueProjectId: query.issueProjectId } : {}),
  })
  return rows.map(toUnifiedIssue)
}

export const localIssueSource: IssueSourceAdapter = {
  kind: "local",
  label: "Local",
  list: listLocalIssues,
  subscribe: (query, observer) => observeIssueList(() => listLocalIssues(query), observer),
}

/**
 * Register the local source. Called from the tracker's initializer; takes an
 * explicit registry in tests so cases stay isolated from the singleton.
 */
export function registerLocalIssueSource(registry: IssueSourceRegistry = getIssueSourceRegistry()) {
  registry.register(localIssueSource)
}
