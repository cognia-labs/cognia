/**
 * Buffered synthesis with the person's speech settings and provider keys: the
 * audio comes back instead of playing. A connector's voice message is built
 * from it (`lib/connectors/voice.ts`, through the `speech` port).
 *
 * A character's `voiceProfile` overlays the person's voice, as when a chat
 * message is read aloud. `approveText` is the orchestrator's own gate, asked
 * before any text reaches a provider.
 */

import { ttsOrchestrator, type TTSSynthesisResult } from "@/lib/tts/tts-orchestrator"
import { selectSpeechSettings } from "@/lib/tts/speech-settings"
import { providerKeyMapToSettingsMap } from "@/lib/tts/keyring"
import { resolveCharacterVoice } from "@/lib/plugin/character-pack/character-voice"
import { useSettingsStore } from "@/stores/settings"
import type { SpeechSynthesisRequest } from "@/types/modules/ports/speech"

export async function synthesizeSpeech({
  text,
  character,
  signal,
  approveText,
}: SpeechSynthesisRequest): Promise<TTSSynthesisResult> {
  await useSettingsStore.getState().ensureProviderKeys()
  signal?.throwIfAborted()
  const store = useSettingsStore.getState()
  const base = selectSpeechSettings(store.settings)
  const overlay = character ? resolveCharacterVoice(character) : undefined
  return ttsOrchestrator.synthesize(text, {
    speechSettings: { ...base, ...overlay },
    providerSettings: providerKeyMapToSettingsMap(store.providerKeys),
    signal,
    approveText,
  })
}
