jest.mock("@/lib/audio/transcode", () => ({
  ...jest.requireActual("@/lib/audio/transcode"),
  transcodeAudio: jest.fn(),
}))
import { transcodeAudio } from "@/lib/audio/transcode"
jest.mock("@/lib/tts/tts-orchestrator", () => ({ ttsOrchestrator: { synthesize: jest.fn() } }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      ensureProviderKeys: async () => {},
      settings: { ttsProvider: "openai", openaiVoice: "alloy", openaiResponseFormat: "aac" },
      providerKeys: {},
    }),
  },
}))
import { synthesizeConnectorVoice, connectorVoiceFormats } from "./voice"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"
import type { PlatformAdapter } from "@/types/connectors/adapter"
const adapter = {
  meta: { capabilities: ["send.voice"] },
  voiceFormats: () => ["audio/mpeg", "audio/wav"],
} as unknown as PlatformAdapter
const target = { platform: "qq-official", adapterId: "a", scene: "group" }
beforeEach(() => {
  jest.mocked(ttsOrchestrator.synthesize).mockReset()
  jest
    .mocked(transcodeAudio)
    .mockReset()
    .mockResolvedValue({
      bytes: new Uint8Array([2, 3]),
      mimeType: "audio/wav",
      sampleRate: 24000,
      channels: 1,
      durationSec: 1,
    })
})
it("uses configured TTS and character voice without local playback, retaining real bytes and format", async () => {
  jest.mocked(ttsOrchestrator.synthesize).mockResolvedValue({
    success: true,
    audioData: new Uint8Array([1, 2, 3]).buffer,
    mimeType: "audio/mpeg",
    provider: "openai",
    billedCharacters: 5,
  })
  expect(
    await synthesizeConnectorVoice({
      adapter,
      target,
      text: "Hello",
      character: { voiceProfile: { provider: "openai", voiceId: "nova" } },
    })
  ).toMatchObject({
    type: "voice",
    url: "data:audio/mpeg;base64,AQID",
    mimeType: "audio/mpeg",
    transcript: "Hello",
  })
  expect(ttsOrchestrator.synthesize).toHaveBeenCalledWith(
    "Hello",
    expect.objectContaining({
      speechSettings: expect.objectContaining({
        ttsProvider: "openai",
        openaiVoice: "nova",
        openaiResponseFormat: "aac",
      }),
    })
  )
})
it("admits SILK-only destinations through generic conversion and still gates PII", async () => {
  expect(connectorVoiceFormats({ ...adapter, voiceFormats: () => ["audio/silk"] }, target)).toEqual(
    ["audio/silk"]
  )
  await expect(
    synthesizeConnectorVoice({ adapter, target, text: "private@example.com" })
  ).rejects.toThrow(/PII/)
  expect(ttsOrchestrator.synthesize).not.toHaveBeenCalled()
})
it("does not mislabel unsupported provider audio as a supported codec", async () => {
  jest.mocked(ttsOrchestrator.synthesize).mockResolvedValue({
    success: true,
    audioData: new ArrayBuffer(3),
    mimeType: "audio/webm",
    provider: "openai",
    billedCharacters: 5,
  })
  await expect(synthesizeConnectorVoice({ adapter, target, text: "Hello" })).rejects.toThrow(
    /format/
  )
})

it.each(["audio/mpeg", "audio/aac", "audio/mp4", "audio/x-m4a"])(
  "converts C2C %s through the shared byte API and retains the spoken transcript",
  async (mimeType) => {
    const signal = new AbortController().signal
    jest.mocked(ttsOrchestrator.synthesize).mockResolvedValue({
      success: true,
      audioData: new Uint8Array([1, 2, 3]).buffer,
      mimeType,
      provider: "openai",
      billedCharacters: 5,
      spokenText: "Dictionary text",
    })
    jest.mocked(transcodeAudio).mockResolvedValue({
      bytes: new Uint8Array([2, 35, 33]),
      mimeType: "audio/silk",
      channels: 1,
      sampleRate: 24000,
      durationSec: 1,
    })
    const result = await synthesizeConnectorVoice({
      adapter: { ...adapter, voiceFormats: () => ["audio/silk"] },
      target: { ...target, scene: "c2c" },
      text: "Hello",
      signal,
    })
    expect(result).toMatchObject({
      mimeType: "audio/silk",
      url: "data:audio/silk;base64,AiMh",
      transcript: "Dictionary text",
      durationSec: 1,
    })
    expect(transcodeAudio).toHaveBeenCalledWith({
      bytes: new Uint8Array([1, 2, 3]),
      source: { mimeType: mimeType === "audio/x-m4a" ? "audio/mp4" : mimeType },
      target: "silk",
      signal,
    })
    expect(ttsOrchestrator.synthesize).toHaveBeenCalledTimes(1)
  }
)
it("validates nominal SILK and never exports corrupt provider bytes", async () => {
  jest.mocked(ttsOrchestrator.synthesize).mockResolvedValue({
    success: true,
    audioData: new Uint8Array([1, 2, 3]).buffer,
    mimeType: "audio/silk",
    provider: "openai",
    billedCharacters: 5,
  })
  jest.mocked(transcodeAudio).mockRejectedValue(new Error("Invalid SILK"))
  await expect(
    synthesizeConnectorVoice({
      adapter: { ...adapter, voiceFormats: () => ["audio/silk"] },
      target,
      text: "Hello",
    })
  ).rejects.toThrow("Invalid SILK")
  expect(transcodeAudio).toHaveBeenCalledWith(expect.objectContaining({ target: "silk" }))
})
it("stops before synthesis when cancelled and rechecks cancellation after synthesis", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    synthesizeConnectorVoice({ adapter, target, text: "Hello", signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" })
  expect(ttsOrchestrator.synthesize).not.toHaveBeenCalled()
  const active = new AbortController()
  jest.mocked(ttsOrchestrator.synthesize).mockImplementation(async () => {
    active.abort()
    return {
      success: true,
      audioData: new ArrayBuffer(2),
      mimeType: "audio/wav",
      provider: "openai",
      billedCharacters: 5,
    }
  })
  await expect(
    synthesizeConnectorVoice({ adapter, target, text: "Hello", signal: active.signal })
  ).rejects.toMatchObject({ name: "AbortError" })
  expect(transcodeAudio).not.toHaveBeenCalled()
})

it("uses shared encoded-format admission for a native M4A destination", async () => {
  const destination = { ...adapter, voiceFormats: () => ["audio/x-m4a"] }
  expect(connectorVoiceFormats(destination, target)).toEqual(["audio/x-m4a"])
  jest.mocked(ttsOrchestrator.synthesize).mockResolvedValue({
    success: true,
    audioData: new Uint8Array([1, 2, 3]).buffer,
    mimeType: "audio/mp4",
    provider: "openai",
    billedCharacters: 5,
  })
  expect(
    await synthesizeConnectorVoice({ adapter: destination, target, text: "Hello" })
  ).toMatchObject({ mimeType: "audio/mp4", url: "data:audio/mp4;base64,AQID" })
  expect(transcodeAudio).toHaveBeenCalledWith(
    expect.objectContaining({ source: { mimeType: "audio/mp4" }, target: "wav" })
  )
})
