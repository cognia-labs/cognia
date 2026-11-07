// The vector module's door onto the person's settings (ADR-0250 §14,
// settings-key ownership). It claims no key of its own: its preferences live
// in the vector store. The agent tools read the kernel's provider settings
// through it to find the embedding provider's key.

import { defineSettingsView } from "@/stores/settings/view"
import vectorModule from "./module"

export const vectorSettingsView = defineSettingsView(vectorModule.settings.keys)
