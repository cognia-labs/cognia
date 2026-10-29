"use client"

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import type { ManagedDesktopReleaseStatus } from "@/lib/automation/managed-desktop-client"

/** Which trusted desktop release the Host loaded. Provisioning stays dormant without one. */
export function ManagedDesktopReleaseStatusLine({
  status,
}: {
  status: ManagedDesktopReleaseStatus | null
}) {
  const t = useTranslations("settings.managedDesktops.release")
  if (!status) return null
  if (status.state === "installed") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs" data-release-state="installed">
        <Badge variant="secondary">
          {status.source === "data-directory" ? t("sourceDataDirectory") : t("sourceBundled")}
        </Badge>
        <span>
          {t("installed", {
            recipe: status.recipeRevision ?? "",
            protocol: status.protocol ?? "",
          })}
        </span>
        <code className="break-all text-muted-foreground">{status.imageDigest}</code>
      </p>
    )
  }
  return (
    <p
      role={status.state === "invalid" ? "alert" : undefined}
      className={
        status.state === "invalid" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
      }
      data-release-state={status.state}
    >
      {status.state === "invalid" ? t("invalid") : t("absent")}
    </p>
  )
}
