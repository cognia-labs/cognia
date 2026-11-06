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
  // voice's native bridge. The provider-key keyring under `lib/tts/` is the
  // settings store's (`scripts/gates/module-ownership.json`); the phone's
  // speech page is the Me tab's, which edits the same settings.
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
  // settings section's drafts and the provider keys are the settings store's.
  dependsOn: ["connectors", "settings-store"],
  // What the composer opens (live voice) and what the character editor tries
  // a voice with.
  api: [
    "components/chat/composer/live-voice-dialog.tsx",
    "components/settings/speech/test-tts-button.tsx",
  ],
  provides: [{ port: "speech", load: () => import("./port") }],
})
