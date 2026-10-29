"use client"

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import {
  watchManagedDesktopMonitor,
  type ManagedDesktopMonitor,
  type ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"

/** What the Host may still bill, what is pending and what needs attention (A7). */
export function ManagedDesktopMonitorPanel({ target }: { target: ManagedDesktopTarget }) {
  const t = useTranslations("settings.managedDesktops.monitor")
  const format = useFormatter()
  const [monitor, setMonitor] = useState<ManagedDesktopMonitor | null>(null)

  useEffect(
    () => watchManagedDesktopMonitor(target, setMonitor),
    // The keyed settings body remounts for every target and account change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  if (!monitor) return null
  const time = (at: number) =>
    format.dateTime(new Date(at), { dateStyle: "short", timeStyle: "medium" })
  const exposure = Object.entries(monitor.maximumExposureMicros)
  return (
    <section
      className="space-y-1 rounded-md border p-3 text-xs"
      aria-label={t("title")}
      data-billed={monitor.billedDesktops}
    >
      <h4 className="font-medium">{t("title")}</h4>
      <p>{t("billed", { count: monitor.billedDesktops })}</p>
      {exposure.map(([currency, micros]) => (
        <p key={currency}>
          {t("exposure", {
            amount: format.number(micros / 1_000_000, { style: "currency", currency }),
          })}
        </p>
      ))}
      {monitor.oldestPendingCreateAt !== null ? (
        <p>{t("pendingCreate", { time: time(monitor.oldestPendingCreateAt) })}</p>
      ) : null}
      {monitor.oldestPendingDeleteAt !== null ? (
        <p>{t("pendingDelete", { time: time(monitor.oldestPendingDeleteAt) })}</p>
      ) : null}
      {monitor.alerts.length > 0 ? (
        <div role="alert" className="space-y-1 text-destructive">
          <p className="font-medium">{t("alertsTitle")}</p>
          <ul className="list-disc pl-4">
            {monitor.alerts.map((alert) => (
              <li key={`${alert.kind}:${alert.subjectId}`}>
                {t(`alert.${alert.kind}`, { subject: alert.subjectId })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
