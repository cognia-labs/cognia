"use client"

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import type { ConnectionView } from "@/lib/external-services/connection-view"

export interface ConnectionRowProps {
  view: ConnectionView
  busy: boolean
  onReconnect: () => void
  onDisconnect: () => void
  onRevokeConsumer: (pluginId: string) => void
}

export function ConnectionRow({
  view,
  busy,
  onReconnect,
  onDisconnect,
  onRevokeConsumer,
}: ConnectionRowProps) {
  const t = useTranslations("settings.externalServices")
  const { connection } = view
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          {view.providerLabel}
          <span>{connection.accountLabel}</span>
          <Badge variant={connection.status === "connected" ? "default" : "secondary"}>
            {t(`connections.status.${connection.status}`)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="space-y-1 break-words text-muted-foreground">
          <div>
            <dt className="inline">{t("connections.issuer")}</dt>{" "}
            <dd className="inline">{connection.issuer}</dd>
          </div>
          {(connection.tenantLabel || connection.tenantId) && (
            <div>
              <dt className="inline">{t("connections.tenant")}</dt>{" "}
              <dd className="inline">{connection.tenantLabel ?? connection.tenantId}</dd>
            </div>
          )}
          <div>
            <dt className="inline">{t("connections.principal")}</dt>{" "}
            <dd className="inline">{t(`connections.principalKind.${connection.principalKind}`)}</dd>
          </div>
          <div>
            <dt className="inline">{t("connections.scopes")}</dt>{" "}
            <dd className="inline">{connection.scopes.join(", ") || t("connections.none")}</dd>
          </div>
          <div>{t("connections.revision", { revision: connection.revision })}</div>
        </dl>
        <section aria-label={t("connections.consumers")} className="space-y-2">
          <h4 className="font-medium">{t("connections.consumers")}</h4>
          {view.consumers.length === 0 && (
            <p className="text-muted-foreground">{t("connections.noConsumers")}</p>
          )}
          {view.consumers.map((consumer) => (
            <div key={consumer.pluginId} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h5 className="font-medium">{consumer.name}</h5>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={t("connections.revokeConsumer", { plugin: consumer.name })}
                  onClick={() => onRevokeConsumer(consumer.pluginId)}
                >
                  {t("connections.revoke")}
                </Button>
              </div>
              {consumer.grants.map((grant) => (
                <div key={grant.id} className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {grant.revision === undefined
                      ? t("connections.unknownRevision")
                      : t("connections.grantedRevision", { revision: grant.revision })}
                  </p>
                  {grant.needsReapproval && (
                    <Badge variant="outline">{t("connections.needsReapproval")}</Badge>
                  )}
                  {(["read", "write"] as const).map((group) => {
                    const operations =
                      group === "read" ? grant.readOperations : grant.writeOperations
                    return (
                      operations.length > 0 && (
                        <div key={group}>
                          <p className="font-medium">{t(`connections.${group}Operations`)}</p>
                          <ul className="break-words text-xs text-muted-foreground">
                            {operations.map((operation) => (
                              <li key={operation}>{operation}</li>
                            ))}
                          </ul>
                        </div>
                      )
                    )
                  })}
                </div>
              ))}
            </div>
          ))}
        </section>
        <div className="flex flex-wrap justify-end gap-2">
          {view.canReconnect && (
            <Button disabled={busy} onClick={onReconnect}>
              {t("connections.reconnect")}
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={busy}>
                {t("connections.disconnect")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("connections.disconnectTitle", { account: connection.accountLabel })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("connections.disconnectDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
                <AlertDialogAction disabled={busy} onClick={onDisconnect}>
                  {t("connections.disconnectConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  )
}
