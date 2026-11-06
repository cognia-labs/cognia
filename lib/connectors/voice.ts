/**
 * Synthesis for connector delivery, through the `speech` port (ADR-0250 §14):
 * the same TTS settings, keys and engine as reading aloud.
 */
import { hasNoLeakingPii } from "@cognia/redact"
import { loadPort } from "@/lib/modules/ports"
import type { CharacterVoiceSource } from "@/lib/plugin/character-pack/character-voice"
import { canTranscodeAudio, normalizeAudioMime, transcodeAudio } from "@/lib/audio/transcode"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { ConversationReference } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

export function connectorVoiceFormats(adapter: PlatformAdapter, target: ConversationReference) {
  const formats = adapter.voiceFormats?.(target) ?? []
  if (
    !adapter.meta.capabilities.includes("send.voice") ||
    !formats.some(
      (mime) => normalizeAudioMime(mime) !== "audio/pcm" && canTranscodeAudio(mime, "audio/wav")
    )
  )
    throw new Error("This destination has no compatible buffered TTS voice format")
  return formats
}

export async function synthesizeConnectorVoice(input: {
  adapter: PlatformAdapter
  target: ConversationReference
  text: string
  character?: CharacterVoiceSource
  signal?: AbortSignal
}): Promise<Extract<MessageSegment, { type: "voice" }>> {
  const formats = connectorVoiceFormats(input.adapter, input.target)
  input.signal?.throwIfAborted()
  // Validate the complete source even for local synthesis or cache hits: the
  // resulting bytes leave the device through the connector.
  if (!hasNoLeakingPii(input.text)) throw new Error("Voice text rejected by the PII gate")
  const speech = await loadPort("speech")
  if (!speech) throw new Error("Speech synthesis is not available on this host")
  input.signal?.throwIfAborted()
  const result = await speech.synthesize({
    text: input.text,
    character: input.character,
    signal: input.signal,
    approveText: hasNoLeakingPii,
  })
  input.signal?.throwIfAborted()
  if (!result.success || !result.audioData)
    throw new Error(result.error ?? "Speech synthesis produced no audio")
  let mimeType = result.mimeType ? normalizeAudioMime(result.mimeType) : undefined
  if (!mimeType) throw new Error("Synthesized audio format is missing")
  if (
    (result.audioData instanceof Blob ? result.audioData.size : result.audioData.byteLength) >
    20_000_000
  )
    throw new Error("Synthesized voice exceeds the delivery size limit")
  let bytes: Uint8Array = new Uint8Array(
    result.audioData instanceof Blob ? await result.audioData.arrayBuffer() : result.audioData
  )
  if (!bytes.length || bytes.length > 20_000_000)
    throw new Error("Synthesized voice exceeds the delivery size limit")
  input.signal?.throwIfAborted()
  const direct = formats.some((format) => normalizeAudioMime(format) === mimeType)
  const targetMime = direct
    ? mimeType
    : formats.find((format) => canTranscodeAudio(mimeType!, format))
  if (!targetMime) throw new Error("Synthesized audio format is unsupported in this destination")
  const target = normalizeAudioMime(targetMime) === "audio/silk" ? "silk" : "wav"
  if (!canTranscodeAudio(mimeType, `audio/${target}`))
    throw new Error("Synthesized audio format cannot be validated for voice delivery")
  // Decode even matching MIME types: a provider's label is not proof of codec
  // bytes or duration. Retain supported MP3/Opus/FLAC only after local validation.
  const converted = await transcodeAudio({
    bytes,
    source: { mimeType },
    target,
    signal: input.signal,
  })
  if (!direct || ["audio/wav", "audio/silk"].includes(mimeType)) {
    bytes = converted.bytes
    mimeType = converted.mimeType
  }
  const durationSec = converted.durationSec
  input.signal?.throwIfAborted()
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return {
    type: "voice",
    url: `data:${mimeType};base64,${btoa(binary)}`,
    mimeType,
    durationSec,
    transcript: result.spokenText ?? input.text,
  }
}
