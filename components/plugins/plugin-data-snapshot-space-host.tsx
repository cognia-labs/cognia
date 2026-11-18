"use client"

/**
 * The question a plugin data migration asks when its snapshot will not fit
 * (ADR-0258): migrate without one, or cancel the upgrade.
 *
 * `runPluginMigrations` waits on `requestPluginDataSnapshotSpaceDecision`
 * until this host answers, so it is mounted at the app root next to the
 * permission prompt: an upgrade or an activation can migrate from any page.
 * Dismissing the dialog without choosing cancels, which leaves the data as it
 * is; only an explicit choice gives up the snapshot.
 */

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { HardDriveIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import {
  resolvePluginDataSnapshotSpaceRequest,
  subscribePluginDataSnapshotSpaceRequests,
  type PluginDataSnapshotSpaceState,
} from "@/lib/plugin/dexie/snapshot-space-requests"

const EMPTY: PluginDataSnapshotSpaceState = { current: null, queue: [] }
const KIB = 1024
const MIB = KIB * 1024
const GIB = MIB * 1024

export function PluginDataSnapshotSpaceHost() {
  const t = useTranslations("plugins.dataSnapshot.space")
  const format = useFormatter()
  const [state, setState] = useState<PluginDataSnapshotSpaceState>(EMPTY)
  useEffect(() => subscribePluginDataSnapshotSpaceRequests(setState), [])
  const request = state.current
  const name = usePluginDisplayName(request?.pluginId ?? null)

  const size = (bytes: number) =>
    bytes >= GIB
      ? format.number(bytes / GIB, { style: "unit", unit: "gigabyte", maximumFractionDigits: 1 })
      : bytes >= MIB
        ? format.number(bytes / MIB, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 })
        : format.number(bytes / KIB, { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 })

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && request) resolvePluginDataSnapshotSpaceRequest(request.id, "cancel")
      }}
    >
      <AlertDialogContent data-testid="plugin-data-snapshot-space">
        {request && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <HardDriveIcon className="size-4 shrink-0" aria-hidden="true" />
                {t("title")}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>
                    {t("body", {
                      name,
                      from: request.fromVersion,
                      to: request.toVersion,
                      required: size(request.requiredBytes),
                    })}{" "}
                    {request.availableBytes === undefined
                      ? t("ranOut")
                      : t("available", { available: size(request.availableBytes) })}
                  </p>
                  <p>{t("consequence", { to: request.toVersion })}</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => resolvePluginDataSnapshotSpaceRequest(request.id, "cancel")}
              >
                {t("cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  resolvePluginDataSnapshotSpaceRequest(request.id, "continue-without-snapshot")
                }
              >
                {t("continue")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
