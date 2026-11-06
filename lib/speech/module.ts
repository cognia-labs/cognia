import { defineHostModule } from "@/lib/modules/define"

// Speech (ADR-0075): reading aloud (TTS), voice input settings and live voice
// sessions. The M3 pilot for capability ports (ADR-0250 §14): it provides the
// `speech` port (`types/modules/ports/speech.ts`), and the chat, the pet, the
// selection toolbar and the connectors ask for the port instead of importing
// `lib/tts/` or `lib/voice/`.
export default defineHostModule({
  id: "speech",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // The read-aloud engine binding and live voice, their React glue, the
  // settings section, the live voice dialog the composer opens, and live
  // voice's native bridge, and the provider keys with their keyring. The
  // phone's speech page is the Me tab's, which edits the same settings.
  owns: [
    "components/chat/composer/live-voice-dialog",
    "components/settings/speech-section",
    "components/settings/speech/",
    "components/tts/",
    "hooks/media/",
    "hooks/voice/",
    "lib/tauri/voice-live.ts",
    "lib/tts/",
    "lib/voice/",
  ],
  // Live voice tool approvals wait in the connectors' HITL registry; the
  // settings section's drafts and the settings view are the settings store's.
  dependsOn: ["connectors", "settings-store"],
  // What the composer opens (live voice), what the character editor tries a
  // voice with, and the speech preferences and provider keys others read.
  api: [
    "components/chat/composer/live-voice-dialog.tsx",
    "components/settings/speech/test-tts-button.tsx",
    "lib/speech/provider-keys.ts",
    "lib/speech/settings.ts",
  ],
  provides: [{ port: "speech", load: () => import("./port") }],
  // Every read-aloud, voice input and live voice preference: the Speech
  // section resets and reviews them, and only `lib/speech/settings.ts` writes
  // them.
  settings: {
    keys: [
      "sttLanguage",
      "selectedMicId",
      "ttsProvider",
      "systemVoice",
      "openaiVoice",
      "openaiModel",
      "openaiSpeed",
      "openaiInstructions",
      "openaiResponseFormat",
      "localOpenaiBaseUrl",
      "localOpenaiModel",
      "localOpenaiVoice",
      "localOpenaiSpeed",
      "localOpenaiResponseFormat",
      "localOpenaiTimeoutMs",
      "geminiVoice",
      "geminiModel",
      "edgeVoice",
      "edgeRate",
      "edgePitch",
      "elevenlabsVoice",
      "elevenlabsModel",
      "elevenlabsStability",
      "elevenlabsSimilarityBoost",
      "lmntVoice",
      "lmntSpeed",
      "humeVoice",
      "cartesiaVoice",
      "cartesiaModel",
      "cartesiaLanguage",
      "cartesiaSpeed",
      "cartesiaEmotion",
      "deepgramVoice",
      "xiaomiVoice",
      "xiaomiModel",
      "xiaomiStyle",
      "xiaomiDialect",
      "mistralVoiceId",
      "mistralModel",
      "mistralResponseFormat",
      "realtimeVoice",
      "realtimeModel",
      "realtimeInstructions",
      "liveVoice",
      "ttsEnabled",
      "ttsRate",
      "ttsPitch",
      "ttsVolume",
      "ttsAutoPlay",
      "ttsCacheEnabled",
      "ttsStreamingEnabled",
      "ttsFallbackEnabled",
      "ttsCustomSSMLEnabled",
      "ttsCustomSSML",
      "ttsPronunciationDictionary",
    ],
  },
})
