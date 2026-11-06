// The pet module's settings (ADR-0250 §14, settings-key ownership): the keys
// its manifest claims, read and written through one view. The pet also reads
// the kernel's keys (the profile, memory, notification preferences) through
// it; other modules read the pet's preferences through this file.

import type { AppSettings } from "@cognia/agent-config-types"
import { defineSettingsView } from "@/stores/settings/view"
import petModule from "./module"

export const petSettingsView = defineSettingsView(petModule.settings.keys)

/** React hook: what `select` picks from the settings, as `SettingsView.use`. */
export function usePetSettingsView<T>(select: (settings: Readonly<AppSettings> | null) => T): T {
  return petSettingsView.use(select)
}
