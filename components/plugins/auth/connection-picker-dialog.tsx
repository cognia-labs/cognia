"use client"

import { useTranslations } from "next-intl"
import type {
  AuthConnectionMetadata,
  AuthConnectionRef,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface ConnectionPickerDialogProps {
  pluginName: string
  candidates: AuthConnectionMetadata[]
  onSelect: (ref: AuthConnectionRef) => void
  onDismiss: () => void
}

export function ConnectionPickerDialog({
  pluginName,
  candidates,
  onSelect,
  onDismiss,
}: ConnectionPickerDialogProps) {
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
          <DialogTitle>{t("pickerTitle", { plugin: pluginName })}</DialogTitle>
          <DialogDescription>{t("pickerDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {candidates.map((connection) => (
            <Button
              key={connection.ref}
              variant="outline"
              className="h-auto w-full justify-start whitespace-normal py-3 text-left"
              aria-label={t("chooseAccount", {
                account: connection.accountLabel,
                issuer: connection.issuer,
              })}
              onClick={() => onSelect(connection.ref)}
            >
              <span className="min-w-0 space-y-1 break-words">
                <span className="block font-medium">{connection.accountLabel}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("issuer", { issuer: connection.issuer })}
                </span>
                {connection.tenantLabel && (
                  <span className="block text-xs text-muted-foreground">
                    {t("tenant", { tenant: connection.tenantLabel })}
                  </span>
                )}
                <span className="block text-xs text-muted-foreground">
                  {t("accountScopes", { scopes: connection.scopes.join(", ") || t("noScopes") })}
                </span>
              </span>
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            {t("dismiss")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
