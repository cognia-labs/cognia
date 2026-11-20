/**
 * The models each built-in provider transcribes with, for a picker that
 * offers a model for `transcription.create` (ADR-0163). The model catalog
 * lists chat models only, and a vendor's `/models` listing does not say which
 * entries transcribe, so this list is kept by hand.
 *
 * Read with {@link builtInTranscriptionModels}:
 *
 * - A list: only those models transcribe there. The ids are the vendor's file
 *   transcription models (`POST /audio/transcriptions`); realtime-only ids
 *   (OpenAI `gpt-live-transcribe`, Mistral `voxtral-*-realtime-*`) are left out
 *   because a recorded file cannot be sent to them.
 * - An empty list: the vendor transcribes, but not through any client this
 *   app builds for it. Its AI SDK client has no transcription factory
 *   (Alibaba, DeepInfra, Fireworks, Together AI), or its OpenAI-compatible
 *   surface has no `/audio/transcriptions` (Cloudflare Workers AI, Hugging
 *   Face, Replicate, fal).
 * - `null`: the deployment decides its own model names (Azure deployments,
 *   local engines, custom providers), so any model may be tried.
 *
 * Sources, checked 2026-11-20:
 * - OpenAI: https://platform.openai.com/docs/guides/speech-to-text
 *   (`gpt-transcribe` recommended; `whisper-1`, `gpt-4o-transcribe`,
 *   `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize` deprecated, shut
 *   down 2027-02-26) and the installed `@ai-sdk/openai` model ids.
 * - Groq: https://console.groq.com/docs/speech-to-text
 * - Mistral: https://docs.mistral.ai/api/endpoint/audio/transcriptions and the
 *   installed `@ai-sdk/mistral` model ids.
 * - SiliconFlow: https://docs.siliconflow.com/cn/api-reference/audio/create-audio-transcriptions
 * - StepFun: https://platform.stepfun.com/docs/api-reference/audio/transcriptions
 * - Cloudflare: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
 *   (chat completions and embeddings only).
 *
 * A vendor that ships a new transcription model needs a line here before the
 * picker offers it, unless the user adds the id to the provider's models.
 */
export const BUILT_IN_TRANSCRIPTION_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: [
    "gpt-transcribe",
    "gpt-4o-transcribe",
    "gpt-4o-mini-transcribe",
    "gpt-4o-mini-transcribe-2025-12-15",
    "gpt-4o-mini-transcribe-2025-03-20",
    "gpt-4o-transcribe-diarize",
    "whisper-1",
  ],
  groq: ["whisper-large-v3-turbo", "whisper-large-v3"],
  mistral: [
    "voxtral-mini-transcribe-latest",
    "voxtral-mini-transcribe-3",
    "voxtral-mini-transcribe-3-0",
    "voxtral-small-transcribe-latest",
    "voxtral-small-transcribe-3",
    "voxtral-small-transcribe-3-0",
    "voxtral-mini-latest",
    "voxtral-mini-2602",
  ],
  siliconflow: ["FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR"],
  stepfun: ["stepaudio-2.5-asr", "step-asr"],
  cloudflare: [],
  deepinfra: [],
  fal: [],
  fireworks: [],
  huggingface: [],
  qwen: [],
  replicate: [],
  togetherai: [],
}

/**
 * The models `providerId` transcribes with: a list (possibly empty, meaning
 * none) for a built-in provider whose model set is known, `null` when the
 * deployment names its own models.
 */
export function builtInTranscriptionModels(providerId: string): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_TRANSCRIPTION_MODELS, providerId)
    ? BUILT_IN_TRANSCRIPTION_MODELS[providerId]
    : null
}
