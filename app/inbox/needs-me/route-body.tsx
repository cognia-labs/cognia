"use client"

/**
 * /inbox/needs-me — unified Personal Responsibility Center (F10).
 *
 * Mounts `<NeedsMeCenter />` inside `<InboxShell view="needs-me">` on wide
 * viewports, and opens `<MobileInboxBody initialTab="needs-me" />` on compact
 * viewports.
 */

import { Suspense } from "react"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { NeedsMeCenter } from "@/components/inbox/needs-me-center"
import { MobileInboxBody } from "@/components/mobile/inbox/mobile-inbox-body"
import { PageLoading } from "@/components/ui/loading-states"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export default function InboxNeedsMePage() {
  const compact = useCompactLayout()
  return (
    <Suspense fallback={<PageLoading />}>
      {compact ? (
        <MobileInboxBody initialTab="needs-me" />
      ) : (
        <InboxShell view="needs-me">
          <NeedsMeCenter />
        </InboxShell>
      )}
    </Suspense>
  )
}
