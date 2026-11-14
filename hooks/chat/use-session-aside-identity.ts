"use client"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { isEmbeddedAside } from "@/lib/context-workbench/resource-session"
import { getDb } from "@/lib/db/schema"

/** Share the one-row subscription across aside entry points, without a cache dependency. */
export function useSessionAsideIdentity(sessionId?: string | null): boolean {
  const session = useClientLiveQuery(
    async () => {
      if (!sessionId?.startsWith("resource-workbench:")) return undefined
      try {
        return await getDb().sessions.get(sessionId)
      } catch {
        return undefined
      }
    },
    [sessionId],
    undefined
  )
  return isEmbeddedAside(sessionId, session)
}
