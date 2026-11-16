"use client"

/**
 * Settings → Network Proxy → General: where the saved policy is actually in
 * effect.
 *
 * "The setting was saved" and "every part of the app now uses it" are two
 * facts. Native HTTP/WebSocket clients read the live policy per connection, so
 * they follow a change on their next connection. A process that was started
 * earlier carries the policy in its environment until it is replaced: the
 * agent runtime (the sidecar) is the one such owner today. `proxy_apply` stops
 * it when it is idle; when a turn was running it is kept, and this panel says
 * so and offers an explicit restart instead of cutting the turn off silently.
 *
 * Reads `proxy_get_active` (sanitized: no credentials, no URL). Renders
 * nothing where there is no native Host to ask (web, secondary windows), which
 * `getProxyRuntimeStatus` signals by omitting `applications`.
 */

import { useTranslations } from "next-intl"
import { useCallback, useEffect, useState } from "react"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { restartSidecar } from "@/lib/native/local-runtime"
import { NETWORK_PROXY_APPLIED_EVENT } from "@/lib/network/proxy-events"
import { getProxyRuntimeStatus } from "@/stores/network-proxy"
import type { ProxyActiveStatus, ProxyOwnerApplication } from "@/types/network/proxy"

/** How often to re-read while an owner is pending, so a restart elsewhere shows up. */
export const PENDING_REFRESH_MS = 5_000

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; status: ProxyActiveStatus }

export function ProxyApplicationStatus() {
  const t = useTranslations("settings.network.application")
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [confirming, setConfirming] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartFailed, setRestartFailed] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const status = await getProxyRuntimeStatus()
      setLoad({ kind: "ready", status })
    } catch {
      setLoad({ kind: "failed" })
    }
  }, [])

  useEffect(() => {
    // The first read is the subscription's initial snapshot, not a derived
    // state write; later reads follow the native apply event.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial native snapshot
    void refresh()
    const onApplied = () => void refresh()
    window.addEventListener(NETWORK_PROXY_APPLIED_EVENT, onApplied)
    return () => window.removeEventListener(NETWORK_PROXY_APPLIED_EVENT, onApplied)
  }, [refresh])

  const agentRuntime =
    load.kind === "ready"
      ? load.status.applications?.find((row) => row.owner === "agent-runtime")
      : undefined
  const pending = agentRuntime?.state === "restart-pending"

  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => void refresh(), PENDING_REFRESH_MS)
    return () => clearInterval(timer)
  }, [pending, refresh])

  const restart = async () => {
    setRestarting(true)
    setRestartFailed(false)
    try {
      await restartSidecar()
    } catch {
      setRestartFailed(true)
    } finally {
      setRestarting(false)
      setConfirming(false)
      void refresh()
    }
  }

  if (load.kind === "loading") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {t("loading")}
      </p>
    )
  }
  if (load.kind === "failed") {
    return (
      <p className="text-xs text-destructive" role="alert">
        {t("unavailable")}
      </p>
    )
  }
  const { status } = load
  if (status.applications === undefined) return null

  return (
    <section
      className="space-y-3 rounded-md border p-3"
      aria-labelledby="proxy-application-title"
      data-testid="proxy-application-status"
    >
      <div className="space-y-1">
        <h3 id="proxy-application-title" className="text-sm font-medium">
          {t("title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="proxy-policy-state">
        <Badge variant={status.state === "ready" ? "secondary" : "destructive"}>
          {t(`policy.${status.state}`)}
        </Badge>
        {status.errorCode && (
          <span className="font-mono text-muted-foreground">{status.errorCode}</span>
        )}
      </div>

      <div className="space-y-2" data-testid="proxy-owner-agent-runtime">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">{t("owner.agentRuntime")}</span>
          <OwnerBadge application={agentRuntime} />
        </div>
        {pending && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("pendingHint")}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirming(true)}
              disabled={restarting}
            >
              {t("restart")}
            </Button>
          </div>
        )}
        {restartFailed && (
          <p className="text-xs text-destructive" role="alert">
            {t("restartFailed")}
          </p>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restartTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("restartDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restarting}>{t("restartCancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={restarting}
              onClick={(event) => {
                // Keep the dialog open until the stop is confirmed.
                event.preventDefault()
                void restart()
              }}
            >
              {t("restartConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function OwnerBadge({ application }: { application?: ProxyOwnerApplication }) {
  const t = useTranslations("settings.network.application")
  if (!application) return <Badge variant="outline">{t("ownerState.notRunning")}</Badge>
  if (application.state === "current") {
    return <Badge variant="secondary">{t("ownerState.current")}</Badge>
  }
  return <Badge variant="destructive">{t("ownerState.pending")}</Badge>
}
