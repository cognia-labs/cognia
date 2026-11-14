"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { MessageSquareIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/schema"
import { parseMessageRefId } from "@/lib/chat/mentions/message-reference"
import type { ContextRef } from "@/lib/chat/mentions/types"
import { withScopedAsides } from "@/lib/chat/session-exposure"
import { revealSideChat } from "@/lib/slash-commands/actions/side-chat"

/** A persisted source link, visible only in the side chat's owning conversation. */
export function SideChatSourceChip({
  citation,
  parentId,
}: {
  citation: ContextRef
  parentId: string
}) {
  const t = useTranslations("contextWorkbench.asides")
  const target =
    citation.kind === "entity" && citation.id.startsWith("message:")
      ? parseMessageRefId(citation.id.slice("message:".length))
      : null
  const asideId = target?.sessionId
  const source = useLiveQuery(async () => {
    if (!asideId) return null
    const [parent, aside] = await Promise.all([
      getDb().sessions.get(parentId),
      getDb().sessions.get(asideId),
    ])
    if (
      !parent ||
      !aside ||
      aside.kind !== "resource-workbench" ||
      !withScopedAsides([parent], [aside]).includes(aside)
    )
      return null
    return { parentId, asideId, title: aside.title }
  }, [parentId, asideId])

  if (!target || !source || source.parentId !== parentId || source.asideId !== asideId) return null
  const label = t("sourceLabel", { title: citation.label || source.title || t("fallbackName") })

  const reveal = async () => {
    try {
      if (!(await revealSideChat(parentId, target.sessionId, target.messageId)))
        toast.info(t("openError"))
    } catch {
      toast.error(t("openError"))
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-auto max-w-full gap-1.5 rounded-full px-2 py-1 text-xs text-muted-foreground"
      onClick={() => void reveal()}
      title={label}
    >
      <MessageSquareIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </Button>
  )
}
