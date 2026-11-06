jest.mock("@/lib/tts/tts-orchestrator", () => ({
  ttsOrchestrator: { synthesize: jest.fn() },
}))

const ensureProviderKeys = jest.fn().mockResolvedValue(undefined)
let storeState: {
  settings: Record<string, unknown> | null
  providerKeys: Record<string, string>
  ensureProviderKeys: jest.Mock
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => storeState },
}))

import { synthesizeSpeech } from "./synthesize-speech"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"

const mockSynthesize = ttsOrchestrator.synthesize as jest.Mock
const RESULT = { success: true, audioData: new Uint8Array([1]), provider: "openai" }

beforeEach(() => {
  mockSynthesize.mockReset().mockResolvedValue(RESULT)
  ensureProviderKeys.mockClear()
  storeState = {
    settings: { ttsEnabled: true, ttsProvider: "system" },
    providerKeys: { openai: "sk-test" },
    ensureProviderKeys,
  }
})

describe("synthesizeSpeech", () => {
  it("loads the keys, then synthesizes with the person's voice and keys", async () => {
    const approveText = jest.fn(() => true)
    const signal = new AbortController().signal
    await expect(synthesizeSpeech({ text: "hello", signal, approveText })).resolves.toBe(RESULT)
    expect(ensureProviderKeys).toHaveBeenCalledTimes(1)
    const [text, options] = mockSynthesize.mock.calls[0]
    expect(text).toBe("hello")
    expect(options.speechSettings.ttsProvider).toBe("system")
    expect(options.providerSettings.openai).toEqual({ apiKey: "sk-test" })
    expect(options.signal).toBe(signal)
    expect(options.approveText).toBe(approveText)
  })

  it("overlays a character's voice on the person's", async () => {
    await synthesizeSpeech({
      text: "hi",
      character: { voiceProfile: { provider: "openai", voiceId: "nova" } },
    })
    const options = mockSynthesize.mock.calls[0][1]
    expect(options.speechSettings.ttsProvider).toBe("openai")
    expect(options.speechSettings.openaiVoice).toBe("nova")
  })

  it("keeps the person's voice for a null character", async () => {
    await synthesizeSpeech({ text: "hi", character: null })
    expect(mockSynthesize.mock.calls[0][1].speechSettings.ttsProvider).toBe("system")
  })

  it("stops before synthesizing when aborted while the keys load", async () => {
    const controller = new AbortController()
    ensureProviderKeys.mockImplementationOnce(async () => controller.abort())
    await expect(synthesizeSpeech({ text: "hi", signal: controller.signal })).rejects.toThrow()
    expect(mockSynthesize).not.toHaveBeenCalled()
  })
})
