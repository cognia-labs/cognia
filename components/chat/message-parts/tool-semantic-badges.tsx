"use client"

import { useTranslations } from "next-intl"
import { EyeIcon, PencilIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"

export interface ToolSemanticBadgesProps {
  readOnlyHint?: boolean | null
}

/** Capability badges supplied by the tool protocol; not execution outcomes. */
export function ToolSemanticBadges({ readOnlyHint }: ToolSemanticBadgesProps) {
  const t = useTranslations("chat.agentFlow.semantic")
  if (readOnlyHint === undefined || readOnlyHint === null) return null

  return readOnlyHint ? (
    <Badge variant="outline" className="gap-1 text-[10px]" data-testid="tool-readonly">
      <EyeIcon className="size-3" aria-hidden />
      {t("readOnly")}
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1 border-info/40 bg-info/10 text-[10px] text-info-ink"
      data-testid="tool-write-capable"
    >
      <PencilIcon className="size-3" aria-hidden />
      {t("writeCapable")}
    </Badge>
  )
}
