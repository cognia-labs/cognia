const orchestrator = {
  getState: jest.fn(() => ({ playbackState: "idle" })),
  subscribe: jest.fn((_listener: () => void) => () => {}),
  stop: jest.fn(),
}
// Delegates lazily: the factory runs before `orchestrator` is initialised.
jest.mock("@/lib/tts/tts-orchestrator", () => ({
  ttsOrchestrator: {
    getState: () => orchestrator.getState(),
    subscribe: (listener: () => void) => orchestrator.subscribe(listener),
    stop: () => orchestrator.stop(),
  },
}))
jest.mock("@/lib/tts/speak-chat-message", () => ({
  speakChatMessage: jest.fn(),
  speakChatMessageStream: jest.fn(),
}))
jest.mock("@/lib/tts/speak-pet", () => ({ speakPetText: jest.fn() }))
jest.mock("@/lib/tts/speak-selection", () => ({
  speakSelection: jest.fn(),
  stopSelectionSpeech: jest.fn(),
  watchSelectionSpeech: jest.fn(),
}))
jest.mock("@/lib/tts/synthesize-speech", () => ({ synthesizeSpeech: jest.fn() }))
jest.mock("@/lib/voice/live/approval", () => ({
  isRealtimeToolApprovalRequestId: jest.fn(),
  grantRealtimeToolAlwaysAllow: jest.fn(),
}))

import { speakChatMessage, speakChatMessageStream } from "@/lib/tts/speak-chat-message"
import { speakPetText } from "@/lib/tts/speak-pet"
import {
  speakSelection,
  stopSelectionSpeech,
  watchSelectionSpeech,
} from "@/lib/tts/speak-selection"
import { synthesizeSpeech } from "@/lib/tts/synthesize-speech"
import {
  grantRealtimeToolAlwaysAllow,
  isRealtimeToolApprovalRequestId,
} from "@/lib/voice/live/approval"

import { port } from "./port"

describe("the speech port's implementation", () => {
  it("reads aloud through the one shared orchestrator", () => {
    const listener = jest.fn()
    expect(port.readAloud.getState()).toEqual({ playbackState: "idle" })
    port.readAloud.subscribe(listener)
    expect(orchestrator.subscribe).toHaveBeenCalledWith(listener)
    port.readAloud.stop()
    expect(orchestrator.stop).toHaveBeenCalledTimes(1)
  })

  it("speaks for each surface with the speech module's helpers", () => {
    expect(port.readAloud.speakChatMessage).toBe(speakChatMessage)
    expect(port.readAloud.speakChatMessageStream).toBe(speakChatMessageStream)
    expect(port.readAloud.speakPet).toBe(speakPetText)
    expect(port.readAloud.speakSelection).toBe(speakSelection)
    expect(port.readAloud.stopSelection).toBe(stopSelectionSpeech)
    expect(port.readAloud.watchSelection).toBe(watchSelectionSpeech)
  })

  it("synthesizes with the person's settings and keys", () => {
    expect(port.synthesize).toBe(synthesizeSpeech)
  })

  it("answers the chat's questions about live voice tool approvals", () => {
    expect(port.live.isToolApprovalRequest).toBe(isRealtimeToolApprovalRequestId)
    expect(port.live.allowToolAlways).toBe(grantRealtimeToolAlwaysAllow)
  })
})
