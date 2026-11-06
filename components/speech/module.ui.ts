import { defineUiModule } from "@/lib/modules/define"

// The speech module's UI layer (ADR-0250 §14). Its host layer is
// `lib/speech/module.ts`.
export default defineUiModule({
  id: "speech",
  settingsSections: [
    {
      id: "speech",
      group: "capabilities",
      icon: "Volume2",
      label: "settings.tabs.speech",
      description: "settings.descriptions.speech",
      after: "ocr",
      keywords: [
        "voice",
        "tts",
        "stt",
        "audio",
        "read aloud",
        "openai",
        "elevenlabs",
        "edge",
        "cartesia",
        "deepgram",
        "lmnt",
        "hume",
        "gemini",
        "speech",
        "语音",
        "朗读",
        "听写",
      ],
      load: () => import("@/components/settings/speech-section"),
    },
  ],
  // The global "now playing" bar for read-aloud: it hides itself while nothing
  // plays. It replaced the app runtime's hand-mounted `<TtsNowPlayingBar />`.
  effects: [
    { name: "now-playing-bar", load: () => import("@/components/tts/tts-now-playing-bar") },
  ],
})
