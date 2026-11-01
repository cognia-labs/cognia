"use client"

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import type { KeptCopySourceStatus } from "@/lib/docs-providers/kept-copy-source"

/** Shared by the dock, staged tiles and sent cards; the kept body remains readable. */
export function KeptCopySourceBadge({ status }: { status: KeptCopySourceStatus | undefined }) {
  const t = useTranslations("cloudDocPreview")
  if (!status || status === "unknown" || status === "available") return null
  return (
    <Badge
      variant="outline"
      role="status"
      aria-label={t(`sourceStatus.${status}`)}
      className="max-w-full rounded-md bg-background/95 text-xs whitespace-normal text-muted-foreground"
    >
      {t(`sourceStatus.${status}`)}
    </Badge>
  )
}
