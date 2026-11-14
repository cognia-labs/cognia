"use client"

import { useId, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useElementHeight } from "@/hooks/use-element-height"
import { getMessageMentions, type MentionReadableMessage } from "@/lib/chat/mentions/read"
import { mergeContextRefs } from "@/lib/chat/mentions/merge-refs"
import { SideChatSourceChip } from "./side-chat-source-chip"

const PREVIEW_HEIGHT_PX = 240

/** A measured preview of a user's input, without changing the stored message. */
export function UserMessageBody({
  children,
  previewText,
  message,
  sessionId,
}: {
  children: ReactNode
  previewText: string
  message?: MentionReadableMessage
  sessionId?: string | null
}) {
  const t = useTranslations("chat.message")
  const bodyId = useId()
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const height = useElementHeight(body)
  const overflows = height > PREVIEW_HEIGHT_PX
  const collapsed = overflows && !expanded
  const Icon = expanded ? ChevronUpIcon : ChevronDownIcon
  const sources = message
    ? mergeContextRefs(getMessageMentions(message), []).filter(
        (ref) => ref.kind === "entity" && ref.id.startsWith("message:")
      )
    : []

  return (
    <div className="min-w-0 max-w-full" data-user-message-body>
      <div
        id={bodyId}
        style={{
          maxHeight: expanded ? undefined : PREVIEW_HEIGHT_PX,
          overflow: expanded ? undefined : "hidden",
          maskImage: collapsed
            ? "linear-gradient(to bottom, black calc(100% - 24px), transparent)"
            : undefined,
        }}
      >
        {/* Measure the unconstrained body so reflow and image loading can
            update the preview. Clipped controls must not stay tabbable. */}
        <div
          ref={setBody}
          className="flex min-w-0 flex-col gap-2"
          inert={collapsed || undefined}
          aria-hidden={collapsed || undefined}
        >
          {children}
        </div>
      </div>
      {collapsed && previewText ? (
        <span className="sr-only">{previewText.slice(0, 600)}</span>
      ) : null}
      {overflows ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 h-7 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon className="size-3.5" aria-hidden />
          {t(expanded ? "collapseUserMessage" : "expandUserMessage")}
        </Button>
      ) : null}
      {sessionId && sources.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 has-[button]:mt-2">
          {sources.map((citation) => (
            <SideChatSourceChip key={citation.id} citation={citation} parentId={sessionId} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
