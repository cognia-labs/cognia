"use client"

import { useTranslations } from "next-intl"
import type { AuthConnectionMetadata } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { ConnectionGrantOperation } from "@/lib/plugin/auth/connection-prompts"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface ConnectionGrantDialogProps {
  pluginName: string
  connection: AuthConnectionMetadata
  operations: ConnectionGrantOperation[]
  scopes: string[]
  onApprove: () => void
  onDecline: () => void
  onDismiss: () => void
}

export function ConnectionGrantDialog({
  pluginName,
  connection,
  operations,
  scopes,
  onApprove,
  onDecline,
  onDismiss,
}: ConnectionGrantDialogProps) {
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
          <DialogTitle>{t("grantTitle", { plugin: pluginName })}</DialogTitle>
          <DialogDescription>
            {t("grantDescription", { account: connection.accountLabel })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto text-sm">
          <dl className="space-y-1 break-words">
            <div>
              <dt className="inline text-muted-foreground">{t("accountLabel")}</dt>{" "}
              <dd className="inline">{connection.accountLabel}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">{t("issuerLabel")}</dt>{" "}
              <dd className="inline">{connection.issuer}</dd>
            </div>
            {connection.tenantLabel && (
              <div>
                <dt className="inline text-muted-foreground">{t("tenantLabel")}</dt>{" "}
                <dd className="inline">{connection.tenantLabel}</dd>
              </div>
            )}
          </dl>
          {(["read", "write"] as const).map((group) => {
            const items = operations.filter((operation) =>
              group === "read" ? operation.risk === "read" : operation.risk !== "read"
            )
            return (
              items.length > 0 && (
                <section
                  key={group}
                  aria-label={t(group === "read" ? "readOperations" : "writeOperations")}
                >
                  <h3 className="font-medium">
                    {t(group === "read" ? "readOperations" : "writeOperations")}
                  </h3>
                  <ul className="mt-1 space-y-1">
                    {items.map((operation) => (
                      <li key={operation.id} className="break-words">
                        {t("operation", {
                          integration: operation.integrationLabel,
                          operation: operation.label,
                        })}
                        {operation.risk === "destructive" && (
                          <span className="ml-2 text-destructive">{t("destructive")}</span>
                        )}
                        <span className="block font-mono text-xs text-muted-foreground">
                          {operation.id}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            )
          })}
          <section aria-label={t("scopesLabel")}>
            <h3 className="font-medium">{t("scopesLabel")}</h3>
            <p className="break-words text-muted-foreground">
              {scopes.join(", ") || t("noScopes")}
            </p>
          </section>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss}>
            {t("dismiss")}
          </Button>
          <Button variant="outline" onClick={onDecline}>
            {t("decline")}
          </Button>
          <Button onClick={onApprove}>{t("approve")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
