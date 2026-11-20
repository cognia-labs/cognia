import { isBuiltInProviderId } from "./built-in-provider-catalog"
import { BUILT_IN_TRANSCRIPTION_MODELS, builtInTranscriptionModels } from "./transcription-models"

describe("built-in transcription models", () => {
  it("names only built-in providers", () => {
    for (const providerId of Object.keys(BUILT_IN_TRANSCRIPTION_MODELS)) {
      expect(isBuiltInProviderId(providerId)).toBe(true)
    }
  })

  it("lists file transcription models, never realtime-only ones", () => {
    const all = Object.values(BUILT_IN_TRANSCRIPTION_MODELS).flat()
    expect(all.filter((id) => /realtime|live-transcribe/.test(id))).toEqual([])
    for (const models of Object.values(BUILT_IN_TRANSCRIPTION_MODELS)) {
      expect(new Set(models).size).toBe(models.length)
    }
  })

  it("leads OpenAI with the current model and keeps the deprecated ones until shutdown", () => {
    expect(builtInTranscriptionModels("openai")?.[0]).toBe("gpt-transcribe")
    expect(builtInTranscriptionModels("openai")).toEqual(
      expect.arrayContaining(["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"])
    )
  })

  it("answers an empty list where the vendor transcribes but no client here can", () => {
    expect(builtInTranscriptionModels("togetherai")).toEqual([])
    expect(builtInTranscriptionModels("cloudflare")).toEqual([])
  })

  it("answers null where the deployment names its own models", () => {
    expect(builtInTranscriptionModels("azure")).toBeNull()
    expect(builtInTranscriptionModels("vllm")).toBeNull()
    expect(builtInTranscriptionModels("custom-acme")).toBeNull()
    // Not fooled by keys every object inherits.
    expect(builtInTranscriptionModels("constructor")).toBeNull()
  })
})
