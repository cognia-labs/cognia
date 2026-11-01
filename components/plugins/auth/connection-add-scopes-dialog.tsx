"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function ConnectionAddScopesDialog({
  pluginName,
  accountLabel,
  scopes,
  onReconnect,
  onDecline,
  onDismiss,
}: {
  pluginName: string
  accountLabel: string
  scopes: string[]
  onReconnect: () => void
  onDecline: () => void
  onDismiss: () => void
}) {
  const t = useTranslations("plugins.auth.connections")
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("addScopesTitle", { plugin: pluginName })}</DialogTitle>
          <DialogDescription>
            {t("addScopesDescription", {
              plugin: pluginName,
              scopes: scopes.join(", "),
              account: accountLabel,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss}>
            {t("dismiss")}
          </Button>
          <Button variant="outline" onClick={onDecline}>
            {t("decline")}
          </Button>
          <Button onClick={onReconnect}>{t("reconnect")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
