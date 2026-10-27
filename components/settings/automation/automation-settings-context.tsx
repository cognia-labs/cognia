"use client"

/**
 * One copy of `AutomationSettings` for the whole Settings → UI Automation
 * section.
 *
 * The status strip (engine switch, kill switch) stays mounted above whichever
 * panel is open, and `automation_settings_set` replaces the WHOLE blob
 * including `enabled`. With one copy per panel, as the tab strip had, a panel
 * holding a snapshot from before the strip resumed the engine would write
 * `enabled: false` straight back on its next edit. So every write here is a
 * read-modify-write against what Rust holds, serialized through one queue, and
 * the strip and the panels read the same state.
 *
 * The master switch never goes through `update`: enabling is the operator's
 * deliberate resume and releases an engaged kill switch, which a bulk save must
 * never do (`automation_set_enabled` vs `automation_settings_set`).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { desktop, type AutomationSettings } from "@/lib/automation/client"
import { isTauri, transport } from "@/lib/tauri"

/** Rust's `kill_switch::KILL_SWITCH_EVENT`: the tray, hotkey and IPC triggers all emit it. */
export const KILL_SWITCH_EVENT = "automation:kill-switch"

export interface AutomationSettingsValue {
  /** `null` until the first read lands, and always off the desktop shell. */
  settings: AutomationSettings | null
  loading: boolean
  /** Last read failure, for panels that render instead of a skeleton. */
  loadError: string | null
  saving: boolean
  killSwitchEngaged: boolean
  /** Apply `mutate` to the host's current settings and persist the result. */
  update: (mutate: (current: AutomationSettings) => AutomationSettings) => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  engageKillSwitch: () => Promise<void>
  refresh: () => Promise<void>
}

const AutomationSettingsContext = createContext<AutomationSettingsValue | null>(null)

export function AutomationSettingsProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("automation.feedback")
  const desktopShell = isTauri()
  const [settings, setSettings] = useState<AutomationSettings | null>(null)
  const [loading, setLoading] = useState(desktopShell)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState(0)
  const [killSwitchEngaged, setKillSwitchEngaged] = useState(false)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    if (!isTauri()) return
    try {
      const [next, engaged] = await Promise.all([
        desktop.settingsGet(),
        desktop.killSwitchEngaged(),
      ])
      if (!mountedRef.current) return
      setSettings(next)
      setKillSwitchEngaged(engaged)
      setLoadError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    if (!isTauri()) return
    // Deferred like the audit counters: a synchronous refresh() in the effect
    // body sets state during the commit and trips react-hooks/set-state-in-effect.
    const initial = window.setTimeout(() => void refresh(), 0)
    // The tray item and the global hotkey engage the kill switch without this
    // window knowing; the event is how the strip stops claiming "running".
    const unlisten = transport.subscribe(KILL_SWITCH_EVENT, () => void refresh())
    return () => {
      mountedRef.current = false
      window.clearTimeout(initial)
      unlisten()
    }
  }, [refresh])

  const enqueue = useCallback((job: () => Promise<void>): Promise<void> => {
    setPending((n) => n + 1)
    const run = queueRef.current.then(job)
    queueRef.current = run.catch(() => {})
    return run.finally(() => {
      if (mountedRef.current) setPending((n) => n - 1)
    })
  }, [])

  const update = useCallback(
    async (mutate: (current: AutomationSettings) => AutomationSettings) => {
      // Optimistic, so a segmented control does not lag a round trip behind the click.
      setSettings((current) => (current ? mutate(current) : current))
      try {
        await enqueue(async () => {
          const fresh = await desktop.settingsGet()
          const next = mutate(fresh)
          await desktop.settingsSet(next)
          if (mountedRef.current) setSettings(next)
        })
      } catch (err) {
        toast.error(t("saveFailed"), {
          description: err instanceof Error ? err.message : String(err),
        })
        // Put back whatever the host actually holds rather than the optimistic guess.
        await refresh()
      }
    },
    [enqueue, refresh, t]
  )

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      try {
        await enqueue(() => desktop.setEnabled(enabled))
        toast.success(enabled ? t("engineEnabled") : t("engineDisabled"))
      } catch (err) {
        toast.error(t("saveFailed"), {
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        await refresh()
      }
    },
    [enqueue, refresh, t]
  )

  const engageKillSwitch = useCallback(async () => {
    try {
      // Not queued: an emergency stop must not wait behind a pending save.
      await desktop.killSwitch()
      toast.warning(t("killSwitchEngaged"))
    } catch (err) {
      toast.error(t("killSwitchFailed"), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      await refresh()
    }
  }, [refresh, t])

  const value = useMemo<AutomationSettingsValue>(
    () => ({
      settings,
      loading,
      loadError,
      saving: pending > 0,
      killSwitchEngaged,
      update,
      setEnabled,
      engageKillSwitch,
      refresh,
    }),
    [
      settings,
      loading,
      loadError,
      pending,
      killSwitchEngaged,
      update,
      setEnabled,
      engageKillSwitch,
      refresh,
    ]
  )

  return (
    <AutomationSettingsContext.Provider value={value}>
      {children}
    </AutomationSettingsContext.Provider>
  )
}

export function useAutomationSettings(): AutomationSettingsValue {
  const value = useContext(AutomationSettingsContext)
  if (!value) {
    throw new Error("useAutomationSettings must be used inside <AutomationSettingsProvider>")
  }
  return value
}
