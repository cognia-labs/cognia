"use client"

/** Shared by resource rows and both workspace sync entry points. */
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { resolveIssueResourceSource } from "@/lib/issues/sync/kept-copy-source"
import { isSyncedResource } from "@/lib/issues/sync/bindings"
import type { IssueProject, IssueProjectResource } from "@/types/issues"
import type { KeptCopySourceStatus } from "@/lib/docs-providers/kept-copy-source"

export function issueSourceStateKey(status: KeptCopySourceStatus) {
  return status === "source-deleted"
    ? ("sync.sourceDeleted" as const)
    : status === "source-disconnected"
      ? ("sync.sourceDisconnected" as const)
      : status === "not-on-this-device"
        ? ("sync.sourceNotOnDevice" as const)
        : undefined
}

export function IssueResourceSourceState({ resource }: { resource: IssueProjectResource }) {
  const t = useTranslations("issues")
  const status = useLiveQuery(() => resolveIssueResourceSource(resource), [resource], "unknown")
  const key = issueSourceStateKey(status)
  return key ? <Badge variant="outline">{t(key)}</Badge> : null
}

/** Mixed workspaces can still sync available resources; blocked bindings are refused by the engine. */
export function useIssueSyncAvailability(projects: readonly IssueProject[] | undefined) {
  const resources = (projects ?? []).flatMap((project) =>
    project.resources.filter(isSyncedResource)
  )
  const statuses = useLiveQuery(
    () => Promise.all(resources.map(resolveIssueResourceSource)),
    [projects]
  )
  const needsResolution = resources.some((resource) => resource.captureId)
  const ready = !needsResolution || statuses !== undefined
  const available = statuses?.some((status) => status === "unknown" || status === "available")
  const reason =
    ready && resources.length && !available && statuses?.length
      ? issueSourceStateKey(statuses[0])
      : undefined
  return { canSync: ready && resources.length > 0 && !reason, reason }
}
