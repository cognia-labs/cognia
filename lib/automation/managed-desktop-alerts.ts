/**
 * Turn a Host's managed desktop monitor into notification-centre entries
 * (ADR-0233 §5, amendment A7): a billed desktop past its hard deadline, and
 * cleanup that has not been confirmed for ten minutes.
 *
 * The desktop watches its own Host; a phone or paired browser watches the
 * `/pair` Host it drives. The Host event carries no data, so an alert is
 * always read back through the caller-scoped `managed_desktop_monitor`.
 */
import { isTauri } from "@/lib/platform/detect"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { PAIRED_HOST_REF_PREFIX } from "@/lib/remote-host/target-transport"
import { useAccountStore } from "@/stores/account/account-store"
import type { NotificationInput } from "@/types/notifications"
import {
  watchManagedDesktopMonitor,
  type ManagedDesktopAlert,
  type ManagedDesktopMonitor,
  type ManagedDesktopTarget,
} from "./managed-desktop-client"

/** Where the settings that resolve an alert live. */
export const MANAGED_DESKTOP_SETTINGS_HREF = "/settings?section=sandbox"

export interface ManagedDesktopAlertDeps {
  notify: (input: NotificationInput) => Promise<unknown>
  translate: (key: string, values?: Record<string, string | number>) => string
}

async function defaultDeps(): Promise<ManagedDesktopAlertDeps> {
  const [{ notify }, { getRuntimeTranslator }] = await Promise.all([
    import("@/lib/notifications/runtime"),
    import("@/lib/i18n/runtime-translator"),
  ])
  const t = await getRuntimeTranslator("settings.managedDesktops.alerts")
  return { notify, translate: (key, values) => t(key, values) }
}

/** One centre entry per alert episode: the same kind, subject and start. */
export function managedDesktopAlertKey(alert: ManagedDesktopAlert): string {
  return `managed-desktop:${alert.kind}:${alert.subjectId}:${alert.since}`
}

/**
 * Announce the alerts not announced yet in this session. `announced` is the
 * caller's memory across monitor reads; the dedupe key also coalesces a
 * replay in the centre itself.
 */
export async function announceManagedDesktopAlerts(
  monitor: ManagedDesktopMonitor,
  announced: Set<string>,
  deps?: ManagedDesktopAlertDeps
): Promise<void> {
  const fresh = monitor.alerts.filter((alert) => !announced.has(managedDesktopAlertKey(alert)))
  if (fresh.length === 0) return
  const { notify, translate } = deps ?? (await defaultDeps())
  for (const alert of fresh) {
    const key = managedDesktopAlertKey(alert)
    announced.add(key)
    const minutes = Math.max(1, Math.floor((monitor.observedAt - alert.since) / 60_000))
    try {
      await notify({
        source: "system",
        level: alert.kind === "pastDeadline" ? "error" : "warning",
        title: translate(`${alert.kind}.title`),
        body: translate(`${alert.kind}.body`, {
          subject: alert.subjectId,
          config: alert.providerConfigId,
          minutes,
        }),
        href: MANAGED_DESKTOP_SETTINGS_HREF,
        dedupeKey: key,
        directed: true,
      })
    } catch (error) {
      // Not announced: the next monitor read tries again.
      announced.delete(key)
      console.warn("managed desktop alert: notification failed", error)
    }
  }
}

/** The Host this client should watch, or none. */
export function managedDesktopAlertTarget(): ManagedDesktopTarget | null {
  if (isTauri()) return { kind: "local" }
  const active = getActiveRuntimeTargetContext()
  const config = loadCompanionConfig()
  if (!active || !config || config.targetId !== active.targetId) return null
  return { kind: "remote", hostId: `${PAIRED_HOST_REF_PREFIX}${active.targetId}` }
}

/**
 * Watch the current Host and announce its alerts; follows changes of the
 * driven `/pair` Host. Returns the stop function.
 */
export function startManagedDesktopAlerts(
  deps?: ManagedDesktopAlertDeps,
  resolveTarget: () => ManagedDesktopTarget | null = managedDesktopAlertTarget
): () => void {
  const announced = new Set<string>()
  let current: string | null = null
  let stopWatch: (() => void) | undefined
  const follow = () => {
    // A watch is bound to the unlocked account; a lock or switch restarts it.
    const account = useAccountStore.getState()
    const target = account.locked || !account.unlockedAccountId ? null : resolveTarget()
    const key = target ? JSON.stringify([account.unlockedAccountId, target]) : null
    if (key === current) return
    current = key
    stopWatch?.()
    stopWatch = undefined
    announced.clear()
    if (!target) return
    stopWatch = watchManagedDesktopMonitor(
      target,
      (monitor) => void announceManagedDesktopAlerts(monitor, announced, deps),
      // A Host without managed desktops installed has nothing to announce.
      () => undefined
    )
  }
  const unsubscribe = [subscribeRuntimeTargetContext(follow), useAccountStore.subscribe(follow)]
  follow()
  return () => {
    unsubscribe.forEach((stop) => stop())
    stopWatch?.()
  }
}
