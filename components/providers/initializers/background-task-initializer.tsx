"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"

import { setRendererBackgroundSettleListener } from "@/lib/background-tasks/renderer-subagent-registry"
import {
  onBackgroundJobSettled,
  onBackgroundRunSettled,
  registerBackgroundResultNotifyStrings,
} from "@/hooks/chat/background-result-runtime"
import { startJobSettlementConsumer } from "@/lib/background-tasks/job-settlement-consumer"
import { listBackgroundJobSettlements } from "@/lib/jobs/background-jobs"
import { isTauri, onTauriEvent } from "@/lib/tauri"
import { remoteEventResyncCoordinator } from "@/lib/tauri/resync-coordinator"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { startBackgroundTaskRecovery } from "@/lib/background-tasks/redispatch"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useAccountStore } from "@/stores/account/account-store"

/**
 * Account-scoped lifecycle for background subagent runs:
 *  1. wire the settle listener (completion re-injection + notifications) and
 *     its localized copy,
 *  2. periodically reconcile expired execution owners to `interrupted`,
 *  3. prune stale settled history (age + cap),
 *  4. opt-in: recover safe interrupted runs through the shared dispatch path,
 *  5. consume background shell and monitor ends (ADR-0249): the supervisor's
 *     events plus reconciliation at start and after missed events, for
 *     whichever supervisor this window reaches (its own, or a paired Host's).
 */
export function BackgroundTaskInitializer() {
  const t = useTranslations("desktop.jobCenter.notify")
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const { target, vaultState } = useRuntimeSnapshot()
  const targetId = target?.id

  useEffect(() => {
    setRendererBackgroundSettleListener(onBackgroundRunSettled)
    const unregisterStrings = registerBackgroundResultNotifyStrings({
      title: ({ subagentId, status, elapsed }) =>
        status === "done"
          ? t("doneTitle", { subagentId, elapsed })
          : t("failedTitle", { subagentId, elapsed }),
      body: ({ runId }) => t("body", { runId }),
      wakeDeferredTitle: ({ count }) => t("wakeDeferredTitle", { count }),
      wakeDeferredBody: ({ reason }) =>
        reason === "cap" ? t("wakeDeferredBodyCap") : t("wakeDeferredBodyBudget"),
    })
    return () => {
      setRendererBackgroundSettleListener(undefined)
      unregisterStrings()
    }
    // `t` is stable per locale; re-registering on locale change is desired.
  }, [t])

  useEffect(() => {
    if (vaultState !== "unlocked" || !targetId) return
    let disposed = false
    const stop = startBackgroundTaskRecovery({
      onResumed: async (count) => {
        const { notify } = await import("@/lib/notifications/runtime")
        if (disposed) return
        await notify({
          source: "session",
          level: "info",
          title: t("autoResumed", { count }),
          channels: ["center", "toast"],
          dedupeKey: "background-auto-resume",
        })
      },
    })
    return () => {
      disposed = true
      stop()
    }
  }, [accountRevision, targetId, vaultState, t])

  useEffect(() => {
    if (vaultState !== "unlocked" || !targetId) return
    // A web build with no paired Host reaches no supervisor.
    if (!isTauri() && !isRemoteHostActive()) return
    const consumer = startJobSettlementConsumer({
      host: "renderer",
      subscribe: onTauriEvent,
      listSettlements: listBackgroundJobSettlements,
      onSettled: onBackgroundJobSettled,
      registerResync: (domain, resolver) => remoteEventResyncCoordinator.register(domain, resolver),
      warn: (message, error) => console.warn(message, error),
    })
    return () => consumer.stop()
  }, [accountRevision, targetId, vaultState])

  return null
}
