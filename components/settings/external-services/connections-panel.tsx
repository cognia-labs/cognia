"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useAuthConnections } from "@/hooks/external-services/use-auth-connections"
import { connectProvider } from "@/lib/plugin/auth/connect"
import { disconnect } from "@/lib/plugin/auth/connection-manager"
import { revokeConsumerAccess } from "@/lib/plugin/auth/revoke-consumer-access"
import { ConnectionRow } from "./connection-row"

export function ConnectionsPanel() {
  const t = useTranslations("settings.externalServices")
  const { rows, providers, loading, failed } = useAuthConnections()
  const [busy, setBusy] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setActionFailed(false)
    try {
      await action()
    } catch {
      setActionFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="space-y-3"
      aria-labelledby="auth-connections-heading"
      aria-busy={loading || busy}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="auth-connections-heading" className="text-sm font-semibold">
          {t("connections.title")}
        </h3>
        <div className="flex flex-wrap gap-2">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() => connectProvider({ providerId: provider.id, scopes: [] }))
              }
            >
              {t("connections.signIn", { provider: provider.label })}
            </Button>
          ))}
        </div>
      </div>
      {(failed || actionFailed) && (
        <p role="alert" className="text-sm text-destructive">
          {t("connections.failed")}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("connections.loading")}</p>
      ) : !failed && rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("connections.empty")}
        </p>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((view) => (
          <ConnectionRow
            key={view.connection.id}
            view={view}
            busy={busy}
            onReconnect={() =>
              void run(() =>
                connectProvider({
                  providerId: view.connection.providerId,
                  reconnect: view.connection.id,
                  scopes: [...view.connection.scopes],
                })
              )
            }
            onDisconnect={() => void run(() => disconnect(view.connection.id, { revoke: true }))}
            onRevokeConsumer={(pluginId) =>
              void run(() => revokeConsumerAccess(view.connection.id, pluginId))
            }
          />
        ))}
      </div>
    </section>
  )
}
