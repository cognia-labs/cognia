// The speech module's settings (ADR-0250 §14, settings-key ownership): the
// keys its manifest claims, read and written through one view, and the
// setters that clamp the read-aloud sliders before they are saved. Other
// modules read a speech preference through this file, not the settings store.

import type { AppSettings } from "@cognia/agent-config-types"
import { defineSettingsView } from "@/stores/settings/view"
import speechModule from "./module"

export const speechSettingsView = defineSettingsView(speechModule.settings.keys)

/** React hook: what `select` picks from the settings, as `SettingsView.use`. */
export function useSpeechSettingsView<T>(select: (settings: Readonly<AppSettings> | null) => T): T {
  return speechSettingsView.use(select)
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function setTtsEnabled(enabled: boolean): Promise<void> {
  return speechSettingsView.update({ ttsEnabled: enabled })
}

export function setTtsProvider(provider: NonNullable<AppSettings["ttsProvider"]>): Promise<void> {
  return speechSettingsView.update({ ttsProvider: provider })
}

export function setTtsAutoPlay(enabled: boolean): Promise<void> {
  return speechSettingsView.update({ ttsAutoPlay: enabled })
}

/** Playback rate, clamped to [0.1, 10]. */
export function setTtsRate(rate: number): Promise<void> {
  return speechSettingsView.update({ ttsRate: clamp(rate, 0.1, 10) })
}

/** Pitch, clamped to [0, 2]. */
export function setTtsPitch(pitch: number): Promise<void> {
  return speechSettingsView.update({ ttsPitch: clamp(pitch, 0, 2) })
}

/** Volume, clamped to [0, 1]. */
export function setTtsVolume(volume: number): Promise<void> {
  return speechSettingsView.update({ ttsVolume: clamp(volume, 0, 1) })
}
