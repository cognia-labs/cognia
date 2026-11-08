"use client"

/**
 * Whether shared conversations are available here, live (ADR-0252 §6).
 *
 * # Why a hook and not a bare call
 *
 * The answer moves: the settings switch, a collaboration server added or
 * removed, the account signing in, the server starting or stopping to serve
 * shared chat. A component that read it once would keep offering to share a
 * conversation the plane no longer serves, or keep hiding an entry it now
 * does. The hook re-renders on every change of the detected answer
 * (`lib/collab/shared-chat-availability.ts`) and asks again when it is stale.
 *
 * # Why the first render always says `checking`
 *
 * The answer reads `localStorage` and the network, and this app is a static
 * export. The server snapshot and the first client render both say
 * `checking`, which offers nothing and names nothing missing; the probe
 * settles it right after mount.
 */

import { useEffect, useSyncExternalStore } from "react"

import {
  readSharedChatAvailability,
  refreshSharedChatAvailability,
  subscribeSharedChatAvailability,
  type SharedChatAvailability,
} from "@/lib/collab/shared-chat-availability"
import { useAccountStore } from "@/stores/account/account-store"

const CHECKING: SharedChatAvailability = { state: "checking" }

/** The detected answer, with the reason when shared chat is not available. */
export function useSharedChatAvailability(): SharedChatAvailability {
  const availability = useSyncExternalStore(
    subscribeSharedChatAvailability,
    readSharedChatAvailability,
    () => CHECKING
  )
  // The answer is per account: a switch asks again.
  const accountId = useAccountStore((state) => state.unlockedAccountId)

  useEffect(() => {
    void refreshSharedChatAvailability()
    const foreground = () => {
      if (document.visibilityState === "visible") void refreshSharedChatAvailability()
    }
    document.addEventListener("visibilitychange", foreground)
    return () => document.removeEventListener("visibilitychange", foreground)
  }, [accountId])

  return availability
}

/** Whether shared chat is offered right now: every entry point's yes. */
export function useSharedChatEnabled(): boolean {
  return useSharedChatAvailability().state === "available"
}
