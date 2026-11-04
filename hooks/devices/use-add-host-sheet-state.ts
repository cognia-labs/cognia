"use client"

/**
 * The device console's "Add host": whether its sheet is open, what it is
 * seeded with, and — off the desktop — where it goes instead.
 *
 * `?addHost=1&baseUrl=…` is how `/servers` and the palette hand a host over.
 * Latched into state rather than read straight from the param, so closing the
 * sheet does not fight a URL that still says "open". The latch is adjusted
 * during render rather than in an effect: an effect would open the sheet one
 * paint late, and `react-hooks/set-state-in-effect` refuses it.
 *
 * Only the desktop files hosts in the registry sheet (`addsHostsToRegistry`).
 * A browser or a phone pairs with a Host through `/pair?mode=add`, the same
 * place its status bar, runtime menu and recovery notices already lead, so
 * `request()` and the hand-off param both route there instead of opening a
 * sheet that would file the Host in a second store.
 *
 * Shared by the desktop console and the phone body, which each used to carry
 * an identical copy of this.
 */

import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { addsHostsToRegistry, COMPANION_ADD_HOST_HREF } from "@/lib/devices/pair-entry"

export interface AddHostSheetState {
  open: boolean
  setOpen: (open: boolean) => void
  /** Seeds the payload field, from a `/servers` hand-off. */
  seededBaseUrl: string | undefined
  /** "Add host": open the registry sheet on the desktop, route to `/pair` elsewhere. */
  request: () => void
}

export function useAddHostSheetState(): AddHostSheetState {
  const router = useRouter()
  const searchParams = useSearchParams()
  const addHostParam = searchParams.get("addHost")
  const seededBaseUrl = searchParams.get("baseUrl") ?? undefined
  const [open, setOpenState] = useState(() => Boolean(addHostParam) && addsHostsToRegistry())
  const [seenParam, setSeenParam] = useState(addHostParam)
  if (addHostParam !== seenParam) {
    setSeenParam(addHostParam)
    // Only a *new* param opens the sheet. Clearing it must not slam a sheet
    // the user opened from the header shut.
    if (addHostParam && addsHostsToRegistry()) setOpenState(true)
  }

  // A hand-off that lands off the desktop has no sheet to open. Navigation is
  // not state, so it belongs in an effect; `replace` keeps Back from bouncing
  // the user into the redirect again.
  useEffect(() => {
    if (addHostParam && !addsHostsToRegistry()) router.replace(COMPANION_ADD_HOST_HREF)
  }, [addHostParam, router])

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next && addsHostsToRegistry())
  }, [])

  const request = useCallback(() => {
    if (addsHostsToRegistry()) setOpenState(true)
    else router.push(COMPANION_ADD_HOST_HREF)
  }, [router])

  return { open, setOpen, seededBaseUrl, request }
}
