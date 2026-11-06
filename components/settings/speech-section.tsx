"use client"

import { SettingsStack } from "./common/settings-block"
import { SttCard } from "./speech/stt-card"
import { LiveVoiceCard } from "./speech/live-voice-card"
import { TtsCard } from "./speech/tts-card"

/**
 * Combined Speech section — STT (voice input) + TTS (read-aloud).
 *
 * Mirrors Cognia's `components/settings/system/speech-settings.tsx`. Each
 * part is a flat `SettingsBlock`; the stack separates them with one hairline
 * and even spacing, as the other flat settings pages do.
 */
export function SpeechSection() {
  return (
    <SettingsStack>
      <SttCard />
      <LiveVoiceCard />
      <TtsCard />
    </SettingsStack>
  )
}

export default SpeechSection
