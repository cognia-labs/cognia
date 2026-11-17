"use client"
import { useTranslations } from "next-intl"

import { CannedResponsePicker } from "@/components/inbox/canned-response-picker"
import { InboxComposerActionsHost } from "@/components/inbox/inbox-composer-actions-host"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import { Button } from "@/components/ui/button"
import type { ChatSession } from "@cognia/agent-config-types"

import { PlatformReplyAssistance } from "./platform-reply-assistance"

/**
 * The row above an IM-bound composer: where the message goes, the reply
 * assistance, the pending-draft review, canned responses and the
 * connector's own composer actions.
 */
export function PlatformComposerHeader({
  session,
  binding,
  disabled,
  pendingDraftCount,
  onReviewDrafts,
}: {
  session: ChatSession
  /** The session's `platformBinding`, passed already narrowed. */
  binding: NonNullable<ChatSession["platformBinding"]>
  disabled?: boolean
  pendingDraftCount: number
  onReviewDrafts: () => void
}) {
  const tPlatform = useTranslations("chatPlatformComposer")
  const tPlatformName = useTranslations("inbox.platformBadge.names")
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <PlatformBadge platform={binding.platform} />
      <span className="min-w-0 flex-1 truncate">
        {tPlatform("destination", {
          platform: tPlatformName.has(binding.platform)
            ? tPlatformName(binding.platform)
            : binding.platform,
          destination: session.title ?? binding.conversationKey,
        })}
      </span>
      <PlatformReplyAssistance key={session.id} session={session} disabled={disabled} />
      <Button type="button" size="sm" variant="ghost" onClick={onReviewDrafts}>
        {tPlatform("reviewDrafts", { count: pendingDraftCount })}
      </Button>
      <CannedResponsePicker
        conversationKey={binding.conversationKey}
        context={{
          conversation: {
            title: session.title,
            platform: binding.platform,
          },
          contact: { platform: binding.platform },
        }}
      />
      <InboxComposerActionsHost
        conversationKey={binding.conversationKey}
        adapterId={binding.adapterId}
        platform={binding.platform}
        sessionId={session.id}
        className="flex shrink-0 items-center gap-1 empty:hidden"
      />
    </div>
  )
}
