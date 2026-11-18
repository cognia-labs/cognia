"use client"

/**
 * The data snapshots a rollback can restore, and the migrations that ran
 * without one (ADR-0258).
 *
 * A snapshot is taken before each upgrade that migrates the plugin's data.
 * When the user chose to upgrade without one (not enough space), or a Host
 * with nobody to ask did, that data version cannot be brought back; saying so
 * here is the only place the user learns it before a rollback refuses.
 *
 * A mirrored client keeps no plugin data of its own, so there is nothing to
 * list there.
 */

import { useFormatter, useTranslations } from "next-intl"
import { DatabaseBackupIcon, TriangleAlertIcon } from "lucide-react"

import { usePluginDataSnapshots } from "@/hooks/plugins/use-plugin-data-snapshots"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"

const SNAPSHOT_DATE_FORMAT = { dateStyle: "medium", timeStyle: "short" } as const

export function PluginDataSnapshots({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.dataSnapshot.list")
  const format = useFormatter()
  const mirrored = isMirroredPluginClient()
  const { records, error } = usePluginDataSnapshots(pluginId, !mirrored)
  if (mirrored) return null

  return (
    <section className="space-y-1.5" data-testid="plugin-data-snapshots">
      <h4 className="text-xs font-medium text-muted-foreground">{t("title")}</h4>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {t("loadFailed")}
        </p>
      ) : records === null ? null : records.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-1">
          {records.map((record) => {
            const date = format.dateTime(new Date(record.createdAt), SNAPSHOT_DATE_FORMAT)
            return record.kind === "captured" ? (
              <li key={record.id} className="flex gap-1.5 text-xs text-muted-foreground">
                <DatabaseBackupIcon className="size-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  {t("captured", {
                    from: record.dataVersion,
                    to: record.migratedTo,
                    rows: record.rows,
                    date,
                  })}
                </span>
              </li>
            ) : (
              <li
                key={record.id}
                className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                data-testid="plugin-data-snapshot-skipped"
              >
                <TriangleAlertIcon className="size-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  {t("skipped", { from: record.dataVersion, to: record.migratedTo, date })}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
