// The speech module's implementation of the `speech` port
// (`types/modules/ports/speech.ts`, ADR-0250 §14). `lib/modules/ports.ts`
// loads it the first time a user asks for the port, on any host: reading aloud
// and live voice need a window, while `synthesize` also runs on the brain,
// where a connector sends voice messages.

import {
  grantRealtimeToolAlwaysAllow,
  isRealtimeToolApprovalRequestId,
} from "@/lib/voice/live/approval"
import { speakChatMessage, speakChatMessageStream } from "@/lib/tts/speak-chat-message"
import { speakPetText } from "@/lib/tts/speak-pet"
import {
  speakSelection,
  stopSelectionSpeech,
  watchSelectionSpeech,
} from "@/lib/tts/speak-selection"
import { synthesizeSpeech } from "@/lib/tts/synthesize-speech"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"
import type { SpeechPort } from "@/types/modules/ports/speech"

export const port: SpeechPort = {
  readAloud: {
    getState: () => ttsOrchestrator.getState(),
    subscribe: (listener) => ttsOrchestrator.subscribe(listener),
    stop: () => ttsOrchestrator.stop(),
    speakChatMessage,
    speakChatMessageStream,
    speakPet: speakPetText,
    speakSelection,
    stopSelection: stopSelectionSpeech,
    watchSelection: watchSelectionSpeech,
  },
  synthesize: synthesizeSpeech,
  live: {
    isToolApprovalRequest: isRealtimeToolApprovalRequestId,
    allowToolAlways: grantRealtimeToolAlwaysAllow,
  },
}
