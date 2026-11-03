"use client"

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  getCollabRefreshState,
  isCollabRefreshStale,
  subscribeCollabRefreshState,
} from "@/lib/collab/refresh-scheduler"

/**
 * Whether the collaboration mirror has gone stale: the last successful
 * refresh is older than the scheduler's threshold.
 *
 * `/issues` reads this fact rather than mounting the badge, because its page
 * header draws one typed status chip and ranks this state against its others.
 * The workspace sections that sit in a page body keep the badge.
 */
export function useCollabRefreshStale(): boolean {
  const localAccountId = getActiveAccountId()
  useSyncExternalStore(
    subscribeCollabRefreshState,
    () => getCollabRefreshState(localAccountId),
    () => getCollabRefreshState(localAccountId)
  )
  return isCollabRefreshStale(localAccountId)
}

export function CollabRefreshStaleBadge() {
  const t = useTranslations("issues.freshness")
  const stale = useCollabRefreshStale()
  if (!stale) return null
  return (
    <Badge variant="outline" className="border-amber-500/60" data-testid="collab-refresh-stale">
      {t("stale")}
    </Badge>
  )
}
