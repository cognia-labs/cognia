"use client"

/**
 * What the machine itself allows the automation engine to do, as opposed to
 * what the user configured: the backend's capability probe, the OS permissions
 * screen control depends on, and a backend that failed to start.
 *
 * Read once by Settings → UI Automation and handed to the status strip, the
 * overview's setup checklist and the diagnostics panel, so the three cannot
 * disagree about whether, say, Screen Recording is granted.
 *
 * The OS permission probes are `record_preflight`'s: the skill recorder
 * already asks macOS for Accessibility / Screen Recording trust and Windows for
 * UI Automation, and reports `notApplicable` where a probe means nothing. Only
 * those fields are read here; the recorder-specific blockers (plugin grants,
 * storage) are not automation's business.
 */

import { useCallback, useEffect, useState } from "react"

import { desktop } from "@/lib/automation/client"
import type { Capabilities } from "@/lib/automation/types"
import { recordPreflight } from "@/lib/skills/recording/recorder-client"
import type { ProbeState } from "@/lib/skills/recording/types"
import { isTauri, transport } from "@/lib/tauri"

export const BACKEND_INIT_FAILED_EVENT = "automation:backend-init-failed"

export interface BackendInitFailure {
  platform: string
  error: string
}

export interface AutomationOsPermissions {
  /** macOS Accessibility trust: synthetic input and the accessibility tree. */
  accessibility: ProbeState
  /** macOS Screen Recording: every screenshot. */
  screenRecording: ProbeState
  /** Windows UI Automation availability. */
  uiAutomation: ProbeState
}

/** The OS permissions this host needs, in the order a checklist should list them. */
export type AutomationOsPermissionKey = keyof AutomationOsPermissions

export const OS_PERMISSION_KEYS: readonly AutomationOsPermissionKey[] = [
  "accessibility",
  "screenRecording",
  "uiAutomation",
]

export interface AutomationHostStatus {
  /** `undefined` while loading, `null` when the probe failed. */
  caps: Capabilities | null | undefined
  /** `undefined` while loading, `null` when the probe failed. */
  permissions: AutomationOsPermissions | null | undefined
  initFailure: BackendInitFailure | null
  dismissInitFailure: () => void
  /** Re-probe after the user comes back from System Settings. */
  refreshPermissions: () => Promise<void>
}

/** Permissions that apply to this host and are not granted. `unknown` is not a gap. */
export function missingOsPermissions(
  permissions: AutomationOsPermissions | null | undefined
): AutomationOsPermissionKey[] {
  if (!permissions) return []
  return OS_PERMISSION_KEYS.filter((key) => permissions[key] === "missing")
}

/** Permissions that mean something on this host, for a status readout. */
export function applicableOsPermissions(
  permissions: AutomationOsPermissions | null | undefined
): AutomationOsPermissionKey[] {
  if (!permissions) return []
  return OS_PERMISSION_KEYS.filter((key) => permissions[key] !== "notApplicable")
}

export function useAutomationHostStatus(): AutomationHostStatus {
  const [caps, setCaps] = useState<Capabilities | null | undefined>(undefined)
  const [permissions, setPermissions] = useState<AutomationOsPermissions | null | undefined>(
    undefined
  )
  const [initFailure, setInitFailure] = useState<BackendInitFailure | null>(null)

  const refreshPermissions = useCallback(async () => {
    if (!isTauri()) return
    try {
      const report = await recordPreflight()
      setPermissions({
        accessibility: report.accessibility,
        screenRecording: report.screenRecording,
        uiAutomation: report.uiAutomation,
      })
    } catch {
      setPermissions(null)
    }
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    desktop
      .capabilities()
      .then((next) => {
        if (!cancelled) setCaps(next)
      })
      .catch(() => {
        if (!cancelled) setCaps(null)
      })
    const initial = window.setTimeout(() => void refreshPermissions(), 0)
    // Two paths converge (ADR-0020 W1): a failure stashed before this window
    // attached a listener (the usual case, during boot) is drained; a later one
    // (a worker restart that re-initialised) arrives on the event.
    transport
      .call<BackendInitFailure | null>("automation_drain_init_failure", {})
      .then((failure) => {
        if (!cancelled && failure) setInitFailure(failure)
      })
      .catch(() => {})
    const unlisten = transport.subscribe<BackendInitFailure>(BACKEND_INIT_FAILED_EVENT, (f) => {
      if (!cancelled) setInitFailure(f)
    })
    return () => {
      cancelled = true
      window.clearTimeout(initial)
      unlisten()
    }
  }, [refreshPermissions])

  const dismissInitFailure = useCallback(() => setInitFailure(null), [])

  return { caps, permissions, initFailure, dismissInitFailure, refreshPermissions }
}
