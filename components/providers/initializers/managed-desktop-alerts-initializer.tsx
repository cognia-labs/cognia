"use client"

import { useEffect } from "react"

import { acquireExclusiveWebLock } from "@/lib/runtime/exclusive-web-lock"

/** One watcher per origin, so two webviews of one app do not alert twice. */
export const MANAGED_DESKTOP_ALERTS_LOCK = "cognia-managed-desktop-alerts"

/**
 * Raise ADR-0233 §5 managed desktop alerts (a billed desktop past its hard
 * deadline, cleanup unconfirmed for ten minutes) in the notification centre,
 * whichever page is open. Every shell: the desktop watches its own Host, a
 * phone or paired browser the Host it drives. The watcher is lazily imported.
 */
export function ManagedDesktopAlertsInitializer() {
  useEffect(() => {
    const lockAbort = new AbortController()
    let stop: (() => void) | undefined
    let cancelled = false

    void (async () => {
      const won = await acquireExclusiveWebLock(MANAGED_DESKTOP_ALERTS_LOCK, lockAbort.signal)
      if (!won || cancelled) return
      const { startManagedDesktopAlerts } = await import("@/lib/automation/managed-desktop-alerts")
      if (cancelled) return
      stop = startManagedDesktopAlerts()
    })().catch(() => undefined)

    return () => {
      cancelled = true
      lockAbort.abort()
      stop?.()
    }
  }, [])
  return null
}
