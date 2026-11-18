"use client"

/**
 * What a rollback does to a plugin's data, said inside the confirmation that
 * asks for it (ADR-0258).
 *
 * Restoring a data snapshot discards everything the plugin saved since it was
 * taken, so the confirmation names the date and the record counts before the
 * user agrees. When the older version cannot read the data and no snapshot can
 * bring it back, the rollback is refused and this says why, and what to do.
 */

import { useFormatter, useTranslations } from "next-intl"
import { DatabaseBackupIcon, TriangleAlertIcon } from "lucide-react"

import type { PluginDataRollback } from "@/lib/plugin/dexie/data-rollback"
import { cn } from "@/lib/utils"

const SNAPSHOT_DATE_FORMAT = { dateStyle: "medium", timeStyle: "short" } as const

interface Props {
  data: PluginDataRollback | null
  /** Reading what the rollback does to the data failed; the rollback waits. */
  checkFailed?: boolean
  /** The plugin's display name. */
  name: string
  /** The version being rolled back to. */
  version: string
  className?: string
}

export function PluginDataRollbackNotice({ data, checkFailed, name, version, className }: Props) {
  const t = useTranslations("plugins.dataSnapshot.notice")
  const format = useFormatter()
  if (checkFailed) {
    return (
      <p className={cn("flex gap-2 text-sm text-destructive", className)} role="alert">
        <TriangleAlertIcon className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{t("checkFailed")}</span>
      </p>
    )
  }
  if (!data || data.kind === "none") return null

  if (data.kind === "unavailable") {
    return (
      <p
        className={cn("flex gap-2 text-sm text-destructive", className)}
        role="alert"
        data-testid="plugin-data-rollback-unavailable"
      >
        <TriangleAlertIcon className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{t("unavailable", { name, version, current: data.currentDataVersion })}</span>
      </p>
    )
  }

  return (
    <p
      className={cn("flex gap-2 text-sm text-amber-700 dark:text-amber-400", className)}
      data-testid="plugin-data-rollback-restore"
    >
      <DatabaseBackupIcon className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        {t("restore", {
          name,
          date: format.dateTime(new Date(data.capturedAt), SNAPSHOT_DATE_FORMAT),
          currentRows: data.currentRows,
          snapshotRows: data.snapshotRows,
        })}
      </span>
    </p>
  )
}

/** The one-line form a version row shows next to its Rollback button. */
export function PluginDataRollbackHint({ data }: { data: PluginDataRollback }) {
  const t = useTranslations("plugins.dataSnapshot.notice")
  const format = useFormatter()
  if (data.kind === "none") return null
  if (data.kind === "unavailable") {
    return <p className="text-xs text-destructive">{t("rowUnavailable")}</p>
  }
  return (
    <p className="text-xs text-muted-foreground">
      {t("rowRestore", {
        date: format.dateTime(new Date(data.capturedAt), SNAPSHOT_DATE_FORMAT),
      })}
    </p>
  )
}
