"use client"

import { useEffect } from "react"

import {
  SELECTION_TOOLBAR_DISABLED_APPS_PREF,
  SELECTION_TOOLBAR_DISABLED_SITES_PREF,
  SELECTION_TOOLBAR_MODE_PREF,
  startSelectionToolbar,
} from "@/lib/tauri/selection-toolbar"
import { getPref, setPref } from "@/lib/tauri/store"
import { parseSelectionToolbarMode } from "@/lib/selection/preferences"
import { ensureBootCapability } from "@/lib/boot/capabilities"

/**
 * Restore the native monitor above AccountGate so an opted-in toolbar keeps
 * working while Cognia is locked or hidden in the tray.
 */
export function SelectionToolbarRestoreInitializer() {
  useEffect(() => {
    void Promise.all([
      getPref<unknown>(SELECTION_TOOLBAR_MODE_PREF),
      getPref<string[]>(SELECTION_TOOLBAR_DISABLED_APPS_PREF),
      getPref<string[]>(SELECTION_TOOLBAR_DISABLED_SITES_PREF),
    ]).then(([savedMode, disabledApps, disabledSites]) => {
      const mode = parseSelectionToolbarMode(savedMode)
      if (mode === "off") return
      void ensureBootCapability("desktop-tools")
        .then(() =>
          startSelectionToolbar({
            mode,
            disabledApps: disabledApps ?? [],
            disabledSites: disabledSites ?? [],
          })
        )
        .catch(() => {
          // Permission may have been revoked between launches. Fail closed and
          // require a fresh explicit opt-in from Desktop settings.
          void setPref(SELECTION_TOOLBAR_MODE_PREF, "off")
        })
    })
  }, [])
  return null
}

export default SelectionToolbarRestoreInitializer
