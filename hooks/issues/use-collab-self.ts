"use client"

/**
 * Who "Me" is on the collaboration plane, live: this profile's bound `User`,
 * `null` when nobody is signed in, `undefined` until the first read lands (so
 * a shared board does not flash "Me" as refused while it loads). Follows
 * sign-in and sign-out without a reload.
 */

import { useClientLiveQuery } from "@/hooks/data"
import { readCollabSelf, type CollabSelf } from "@/lib/issues/collab-actor"

export function useCollabSelf(
  read: () => Promise<CollabSelf | null> = readCollabSelf
): CollabSelf | null | undefined {
  return useClientLiveQuery<CollabSelf | null>(() => read(), [read], null)
}

/** The id the bulk gate and menus take: `undefined` while unknown. */
export function collabSelfUserIdOf(self: CollabSelf | null | undefined): string | null | undefined {
  return self === undefined ? undefined : (self?.userId ?? null)
}
