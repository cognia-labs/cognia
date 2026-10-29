"use client"

import { useEffect, useRef, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useConfirmDialog } from "@/components/shared/confirm-dialog"
import {
  managedDesktopClient,
  managedDesktopErrorKey,
  type ManagedDesktopTarget,
  type ManagedDesktopTemplateSummary,
} from "@/lib/automation/managed-desktop-client"

/**
 * Templates prepared in the user's E2B account (ADR-0233 §2, amendment A7).
 * Never deleted implicitly; an explicit delete waits for confirmed absence.
 */
export function ManagedDesktopTemplates({
  target,
  revision,
  onChanged,
}: {
  target: ManagedDesktopTarget
  /** Changes whenever the surrounding settings reloaded. */
  revision: number
  onChanged: () => void
}) {
  const t = useTranslations("settings.managedDesktops")
  const format = useFormatter()
  const [templates, setTemplates] = useState<ManagedDesktopTemplateSummary[] | null>(null)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const alive = useRef(true)
  const { confirm, dialog } = useConfirmDialog()

  useEffect(() => {
    alive.current = true
    managedDesktopClient.templateList(target).then(
      (next) => {
        if (alive.current) setTemplates(next)
      },
      (cause) => {
        if (alive.current) setError(managedDesktopErrorKey(cause))
      }
    )
    return () => {
      alive.current = false
    }
  }, [target, revision])

  async function remove(template: ManagedDesktopTemplateSummary) {
    if (
      !(await confirm({
        title: t("templates.deleteTitle", { id: template.id }),
        description: t("templates.deleteDescription"),
        confirmLabel: t("templates.delete"),
        destructive: true,
      }))
    )
      return
    setBusy(template.id)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await managedDesktopClient.templateDelete(target, template.id)
      if (!alive.current) return
      if (next === null) setNotice(t("templates.deleted", { id: template.id }))
      onChanged()
    } catch (cause) {
      if (alive.current) setError(managedDesktopErrorKey(cause))
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }

  if (templates === null && !error) return null
  return (
    <section className="space-y-2 rounded-md border p-3 text-xs" aria-label={t("templates.title")}>
      <h4 className="font-medium">{t("templates.title")}</h4>
      {error ? (
        <p role="alert" className="text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {templates?.length === 0 ? (
        <p className="text-muted-foreground">{t("templates.empty")}</p>
      ) : null}
      {templates?.map((template) => (
        <div
          key={template.id}
          className="space-y-1 border-t pt-2"
          data-template-state={template.state}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{template.providerConfigId}</span>
            <code className="break-all text-muted-foreground">
              {template.identity?.templateId ?? template.id}
            </code>
            <Badge variant={template.state === "deleting" ? "destructive" : "outline"}>
              {template.state === "deleting"
                ? t("templates.deleting")
                : t("templates.state", { state: t(`templateState.${template.state}`) })}
            </Badge>
          </div>
          {template.desktopsInUse > 0 ? (
            <p>{t("templates.inUse", { count: template.desktopsInUse })}</p>
          ) : null}
          {template.state === "deleting" && template.nextRetryAt !== null ? (
            <p className="text-muted-foreground">
              {t("templates.retry", {
                attempts: template.cleanupAttempts,
                time: format.dateTime(new Date(template.nextRetryAt), { timeStyle: "medium" }),
              })}
            </p>
          ) : null}
          {template.state !== "deleting" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy !== undefined || template.desktopsInUse > 0 || template.state === "registering"
              }
              onClick={() => void remove(template)}
            >
              {t("templates.delete")}
            </Button>
          ) : null}
        </div>
      ))}
      {dialog}
    </section>
  )
}
