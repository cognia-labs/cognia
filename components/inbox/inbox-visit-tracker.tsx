"use client"

/**
 * Inbox visit tracker.
 *
 * Mounted from `app/inbox/layout.tsx`; bumps `settings.lastInboxViewedAt`
 * to `Date.now()` once on mount so the unread count the mobile Tab Bar's
 * Chat-tab badge reads (`lib/inbox/unread-count.ts`) clears as soon as the
 * user opens any /inbox/* route. It belongs to the inbox, which records the
 * visit; the shell only reads it.
 *
 * Renders nothing.
 */

import { useEffect } from "react"

import { useSettingsStore } from "@/stores/settings"

export function InboxVisitTracker() {
  const save = useSettingsStore((s) => s.save)
  useEffect(() => {
    void save({ lastInboxViewedAt: Date.now() })
  }, [save])
  return null
}
