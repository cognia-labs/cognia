import { ttsFailure, type BufferedTTSResponseFormat, type TTSResponse } from "./types"

const FORMAT_MIME: Record<BufferedTTSResponseFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
}

export function mimeForBufferedFormat(format: BufferedTTSResponseFormat): string {
  return FORMAT_MIME[format]
}

/** Normalize provider Content-Type without preserving codec/charset parameters. */
export function normalizeAudioMime(
  contentType: string | null | undefined,
  fallbackFormat: BufferedTTSResponseFormat
): TTSResponse | { success: true; mimeType: string } {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mime === "audio/pcm" || mime === "audio/l16" || mime === "audio/raw") {
    return ttsFailure("not-supported", {
      providerMessage: "Headerless PCM is not supported by buffered TTS playback",
    })
  }
  if (mime?.startsWith("audio/")) return { success: true, mimeType: mime }
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    return { success: true, mimeType: mimeForBufferedFormat(fallbackFormat) }
  }
  return ttsFailure("not-supported", {
    providerMessage: `Unexpected TTS response content type: ${mime}`,
  })
}

export function pcmToWav(pcmData: ArrayBuffer, sampleRate = 24000, channels = 1): ArrayBuffer {
  const bytesPerSample = 2
  const dataLength = pcmData.byteLength
  const headerLength = 44
  const wav = new ArrayBuffer(headerLength + dataLength)
  const view = new DataView(wav)

  writeString(view, 0, "RIFF")
  view.setUint32(4, 36 + dataLength, true)
  writeString(view, 8, "WAVE")
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeString(view, 36, "data")
  view.setUint32(40, dataLength, true)

  const target = new Uint8Array(wav, headerLength)
  target.set(new Uint8Array(pcmData))
  return wav
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}
