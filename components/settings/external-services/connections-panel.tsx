"use client"

import { useState, useRef, useEffect } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { listPlugins } from "@/lib/db/plugins"
import type { PluginManifest } from "@/types/plugin"
import { collectPluginRuntimeProfileDiagnostics } from "@/lib/plugin/core/runtime-compatibility"
import { useExternalServiceRuntimeProfile } from "@/hooks/plugins/use-external-service-runtime-profile"
import {
  EXTERNAL_SERVICE_RUNTIME_SUPPORT,
  resolveAuthMethodSupport,
  type RuntimeSupportCell,
} from "@/lib/external-services/runtime-support"
import { RuntimeSupportNotice } from "@/components/plugins/auth/runtime-support-notice"
import { DeviceAuthorizationDialog } from "@/components/plugins/auth/device-authorization-dialog"
import { Button } from "@/components/ui/button"
import { useAuthConnections } from "@/hooks/external-services/use-auth-connections"
import { AuthConnectError, connectProvider } from "@/lib/plugin/auth/connect"
import {
  disconnect,
  ConnectionIdentityConflict,
  getHostConnectionDriver,
  type HostDeviceAuthorization,
} from "@/lib/plugin/auth/connection-manager"
import { useConnectorIngress } from "@/hooks/use-connector-ingress"
import { revokeConsumerAccess } from "@/lib/plugin/auth/revoke-consumer-access"
import { ConnectionRow } from "./connection-row"

export function ConnectionsPanel() {
  const t = useTranslations("settings.externalServices")
  const { rows, providers, loading, failed } = useAuthConnections()
  const plugins = useLiveQuery(() => listPlugins(), [], [])
  const profile = useExternalServiceRuntimeProfile()
  const supportFor = (providerId: string, owner: string | null) => {
    const manifest = plugins.find((plugin) => plugin.id === owner)?.manifest as unknown as
      PluginManifest | undefined
    if (manifest) {
      const blocked = collectPluginRuntimeProfileDiagnostics(manifest, profile.local, profile).find(
        (item) => item.severity === "error" && item.reason
      )
      const support = Object.values(EXTERNAL_SERVICE_RUNTIME_SUPPORT)
        .flatMap(Object.values)
        .find((cell) => cell.reason === blocked?.reason)
      if (support) return { ...support, availability: "blocked" as const }
    }
    const provider = manifest?.authProviders?.find((item) => item.id === providerId)
    if (!provider) return undefined
    const methods = (provider.methods ?? ["oauth-pkce"]).map((method) =>
      resolveAuthMethodSupport(method, profile, provider)
    )
    return (
      methods.find((item) => item.availability === "supported") ??
      methods.find((item) => item.availability === "degraded") ??
      methods[0]
    )
  }
  const ingress = useConnectorIngress()
  const [authorization, setAuthorization] = useState<HostDeviceAuthorization | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [busy, setBusy] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const [identityConflict, setIdentityConflict] = useState(false)
  const [runtimeFailure, setRuntimeFailure] = useState<RuntimeSupportCell | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setActionFailed(false)
    setIdentityConflict(false)
    setRuntimeFailure(null)
    try {
      await action()
    } catch (error) {
      setActionFailed(true)
      setIdentityConflict(error instanceof ConnectionIdentityConflict)
      if (error instanceof AuthConnectError) {
        const support = Object.values(EXTERNAL_SERVICE_RUNTIME_SUPPORT)
          .flatMap(Object.values)
          .find((cell) => cell.reason === error.reason)
        if (support) setRuntimeFailure({ ...support, recovery: error.details.recovery })
      }
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
            <div key={provider.id} className="space-y-1">
              <Button
                variant="outline"
                size="sm"
                disabled={
                  busy || supportFor(provider.id, provider.pluginId)?.availability === "blocked"
                }
                onClick={() =>
                  void run(() => connectProvider({ providerId: provider.id, scopes: [] }))
                }
              >
                {t("connections.signIn", { provider: provider.label })}
              </Button>
              {supportFor(provider.id, provider.pluginId) && (
                <RuntimeSupportNotice support={supportFor(provider.id, provider.pluginId)!} />
              )}
            </div>
          ))}
        </div>
      </div>
      {(failed || actionFailed) && (
        <p role="alert" className="text-sm text-destructive">
          {identityConflict ? t("connections.identityConflict") : t("connections.failed")}
        </p>
      )}
      {runtimeFailure && <RuntimeSupportNotice support={runtimeFailure} />}
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
            runtimeSupport={supportFor(view.connection.providerId, view.connection.ownerPluginId)}
            onReconnect={() =>
              void run(async () => {
                const driver =
                  view.connection.ownerPluginId === null
                    ? getHostConnectionDriver(view.connection.providerId)
                    : undefined
                if (driver?.reauthorize) {
                  const result = await driver.reauthorize(view.connection.id, {
                    ingressBase: ingress.base,
                  })
                  if (result) {
                    if (mounted.current) setAuthorization(result)
                    else await result.cancel()
                  }
                } else {
                  await connectProvider({
                    providerId: view.connection.providerId,
                    reconnect: view.connection.id,
                    scopes: [...view.connection.scopes],
                  })
                }
              })
            }
            onDisconnect={() => void run(() => disconnect(view.connection.id, { revoke: true }))}
            onRevokeConsumer={(pluginId) =>
              void run(() => revokeConsumerAccess(view.connection.id, pluginId))
            }
          />
        ))}
      </div>
      {authorization && (
        <DeviceAuthorizationDialog
          authorization={authorization}
          onClose={() => setAuthorization(null)}
        />
      )}
    </section>
  )
}
