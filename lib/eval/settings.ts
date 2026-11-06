// The eval module's settings (ADR-0250 §14, settings-key ownership): the keys
// its manifest claims, read and written through one view. Eval also reads the
// kernel's provider and model keys through it to build a run's options.

import type { AppSettings } from "@cognia/agent-config-types"
import { defineSettingsView } from "@/stores/settings/view"
import evalModule from "./module"

export const evalSettingsView = defineSettingsView(evalModule.settings.keys)

/** React hook: what `select` picks from the settings, as `SettingsView.use`. */
export function useEvalSettingsView<T>(select: (settings: Readonly<AppSettings> | null) => T): T {
  return evalSettingsView.use(select)
}
