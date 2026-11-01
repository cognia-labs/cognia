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

export interface ConnectionSignInDialogProps {
  pluginName: string
  providerLabel: string
  scopes: string[]
  onSignIn: () => void
  onDismiss: () => void
}

/** A sign-in decision precedes the Host flow; consumer access is granted separately. */
export function ConnectionSignInDialog({
  pluginName,
  providerLabel,
  scopes,
  onSignIn,
  onDismiss,
}: ConnectionSignInDialogProps) {
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
          <DialogTitle>{t("signInTitle", { provider: providerLabel })}</DialogTitle>
          <DialogDescription>
            {t("signInDescription", { plugin: pluginName, provider: providerLabel })}
          </DialogDescription>
        </DialogHeader>
        <section className="break-words text-sm" aria-label={t("scopesLabel")}>
          <h3 className="font-medium">{t("scopesLabel")}</h3>
          <p className="text-muted-foreground">{scopes.join(", ") || t("noScopes")}</p>
        </section>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            {t("dismiss")}
          </Button>
          <Button onClick={onSignIn}>{t("signIn")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
