/** Shared byte-audio contracts and admission limits; no codec or provider imports. */
export const AUDIO_INPUT_LIMIT = 20_000_000
export const AUDIO_DURATION_LIMIT = 300
export const DECODED_LIMIT = 64_000_000
export const RATE = 24000
export type AudioTarget = "wav" | "silk"
export interface AudioSource {
  mimeType: string
  /** Required only for headerless signed little-endian PCM16. */
  sampleRate?: number
  channels?: number
}
export interface AudioTranscodeRequest {
  bytes: Uint8Array
  source: AudioSource
  target: AudioTarget
}
export interface TranscodedAudio {
  bytes: Uint8Array
  mimeType: "audio/wav" | "audio/silk"
  sampleRate: 24000
  channels: 1
  durationSec: number
}
export class AudioTranscodeError extends Error {
  constructor(
    readonly code: "unsupported" | "malformed" | "limit" | "busy" | "timeout" | "unavailable",
    message: string
  ) {
    super(message)
    this.name = "AudioTranscodeError"
  }
}
export function fail(code: AudioTranscodeError["code"], message: string): never {
  throw new AudioTranscodeError(code, message)
}
export function normalizeAudioMime(mime: string): string {
  const value = mime.split(";")[0].trim().toLowerCase()
  return (
    (
      {
        "audio/mp3": "audio/mpeg",
        "audio/x-wav": "audio/wav",
        "audio/x-silk": "audio/silk",
        "audio/opus": "audio/ogg",
        "audio/x-flac": "audio/flac",
        "audio/x-aac": "audio/aac",
        "audio/aacp": "audio/aac",
        "audio/m4a": "audio/mp4",
        "audio/x-m4a": "audio/mp4",
      } as Record<string, string>
    )[value] ?? value
  )
}
export function canTranscodeAudio(sourceMime: string, targetMime: string): boolean {
  return (
    [
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "audio/flac",
      "audio/pcm",
      "audio/silk",
      "audio/aac",
      "audio/mp4",
    ].includes(normalizeAudioMime(sourceMime)) &&
    ["audio/wav", "audio/silk"].includes(normalizeAudioMime(targetMime))
  )
}
export function validateAudioRequest(input: AudioTranscodeRequest): void {
  if (!input || !(input.bytes instanceof Uint8Array) || !input.bytes.length)
    fail("malformed", "Audio bytes are empty")
  if (input.bytes.length > AUDIO_INPUT_LIMIT) fail("limit", "Audio input exceeds 20 MB")
  if (
    typeof input.source?.mimeType !== "string" ||
    !["wav", "silk"].includes(input.target) ||
    !canTranscodeAudio(input.source.mimeType, `audio/${input.target}`)
  )
    fail("unsupported", "Unsupported audio conversion format")
}
export interface DecodedAudio {
  channelData: Float32Array[]
  sampleRate: number
  errors?: unknown[]
}
