"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { createdDocumentTarget } from "@/lib/docs-providers/created-document"
import { openChatDocument } from "@/lib/artifacts/open-chat-document"

/** Mounted in the tool-call action seam, for both grouped and standalone calls. */
export function CreatedDocumentAction({
  part,
  sessionId,
}: {
  part: Parameters<typeof createdDocumentTarget>[0]
  sessionId?: string
}) {
  const t = useTranslations("cloudDocPreview")
  const target = createdDocumentTarget(part)
  if (!target || !sessionId) return null
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() =>
        openChatDocument({
          sessionId,
          target,
          entry: "tool-result",
          view: "live",
        })
      }
    >
      {t("openDock")}
    </Button>
  )
}
