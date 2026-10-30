/** Local, byte-only audio conversion. This engine runs inside a disposable Worker. */
import { pcmToWav } from "@cognia/tts/audio-response"

import {
  AUDIO_INPUT_LIMIT,
  AUDIO_DURATION_LIMIT,
  DECODED_LIMIT,
  RATE,
  AudioTranscodeError,
  fail,
  normalizeAudioMime,
  validateAudioRequest,
  type AudioTranscodeRequest,
  type TranscodedAudio,
  type DecodedAudio as Decoded,
} from "./formats"
export * from "./formats"

const textAt = (bytes: Uint8Array, offset: number, size: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + size))

/** Reject hostile WAV metadata before a decoder can allocate from it. PCM/float only. */
function validateWav(bytes: Uint8Array): Uint8Array {
  if (textAt(bytes, 0, 4) !== "RIFF" || textAt(bytes, 8, 4) !== "WAVE")
    fail("malformed", "Invalid WAV header")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let rate = 0,
    channels = 0,
    align = 0,
    bitDepth = 0,
    formatCode = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = textAt(bytes, offset, 4),
      size = view.getUint32(offset + 4, true),
      start = offset + 8
    if (size > bytes.length - start) fail("malformed", "Truncated WAV chunk")
    if (tag === "fmt ") {
      if (size < 16) fail("malformed", "Invalid WAV format")
      let format = view.getUint16(start, true)
      if (format === 0xfffe && size >= 40) format = view.getUint16(start + 24, true)
      const bits = view.getUint16(start + 14, true)
      bitDepth = bits
      formatCode = format
      channels = view.getUint16(start + 2, true)
      rate = view.getUint32(start + 4, true)
      align = view.getUint16(start + 12, true)
      if (
        !(format === 1 && [8, 16, 24, 32].includes(bits)) &&
        !(format === 3 && [32, 64].includes(bits))
      )
        fail("unsupported", "WAV requires PCM or IEEE float samples")
      validateShape(rate, channels)
      if (align !== (channels * bits) / 8) fail("malformed", "Invalid WAV block alignment")
    }
    if (tag === "data") {
      if (!align || !size || size % align) fail("malformed", "Invalid WAV data")
      if (
        size / align / rate > AUDIO_DURATION_LIMIT ||
        (size / align) * channels * 4 > DECODED_LIMIT
      )
        fail("limit", "WAV duration or decoded samples exceed the limit")
      // Strip optional metadata into a canonical header. The decoder's RIFF
      // scanner does not handle odd-sized chunk padding; admission above does.
      const normalized = new Uint8Array(
        pcmToWav(bytes.slice(start, start + size).buffer, rate, channels)
      )
      const header = new DataView(normalized.buffer)
      header.setUint16(20, formatCode, true)
      header.setUint32(28, rate * align, true)
      header.setUint16(32, align, true)
      header.setUint16(34, bitDepth, true)
      return normalized
    }
    offset = start + size + (size % 2)
  }
  fail("malformed", "WAV audio data is missing")
}
function validateShape(rate: number, channels: number): void {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 48000 || ![1, 2].includes(channels))
    fail("unsupported", "Audio requires 8–48 kHz mono or stereo samples")
}
/** Tencent packet lengths are little endian. No path, URL or codec options are accepted. */
function silkFrames(bytes: Uint8Array): number {
  if (bytes[0] !== 2 || textAt(bytes, 1, 9) !== "#!SILK_V3")
    fail("malformed", "Expected Tencent SILK framing")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 10,
    count = 0
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) fail("malformed", "Truncated SILK packet")
    const size = view.getUint16(offset, true)
    offset += 2
    if (!size || size > 1250 || offset + size > bytes.length)
      fail("malformed", "Invalid SILK packet")
    offset += size
    if (++count > AUDIO_DURATION_LIMIT * 50) fail("limit", "SILK packet count exceeds the limit")
  }
  if (!count) fail("malformed", "SILK audio is empty")
  return count
}
interface Decoder {
  decode(bytes: Uint8Array): Decoded | Promise<Decoded>
  flush?(): Decoded | Promise<Decoded>
  free(): void
}

/** Bounded single-stream Ogg admission before the codec parses header arrays. */
function validateOggOpus(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0,
    serial = -1,
    sequence = 0,
    packets = 0,
    packetSize = 0,
    ended = false
  let pieces: Uint8Array[] = []
  while (offset < bytes.length) {
    if (
      offset + 27 > bytes.length ||
      textAt(bytes, offset, 4) !== "OggS" ||
      bytes[offset + 4] !== 0
    )
      fail("malformed", "Invalid Ogg page")
    const flags = bytes[offset + 5],
      id = view.getUint32(offset + 14, true)
    const seq = view.getUint32(offset + 18, true),
      segments = bytes[offset + 26]
    if (
      ended ||
      (offset === 0
        ? !(flags & 2) || seq !== 0
        : id !== serial || (flags & 2) !== 0 || seq !== sequence)
    )
      fail("unsupported", "Ogg chaining, multiplexing or missing pages are unsupported")
    if (Boolean(flags & 1) !== packetSize > 0 || flags & 248)
      fail("malformed", "Invalid Ogg packet continuation")
    serial = id
    sequence = seq + 1
    let start = offset + 27 + segments
    if (start > bytes.length) fail("malformed", "Truncated Ogg segment table")
    for (let i = 0; i < segments; i++) {
      const size = bytes[offset + 27 + i]
      if (start + size > bytes.length) fail("malformed", "Truncated Ogg packet")
      packetSize += size
      if (packetSize > 65536) fail("limit", "Ogg packet exceeds the limit")
      if (packets < 2) pieces.push(bytes.subarray(start, start + size))
      start += size
      if (size < 255) {
        if (packets < 2) {
          const packet = new Uint8Array(packetSize)
          let cursor = 0
          for (const piece of pieces) {
            packet.set(piece, cursor)
            cursor += piece.length
          }
          if (packets === 0) {
            if (
              packet.length !== 19 ||
              textAt(packet, 0, 8) !== "OpusHead" ||
              packet[8] > 15 ||
              ![1, 2].includes(packet[9]) ||
              packet[18] !== 0
            )
              fail("unsupported", "Expected mono or stereo Ogg Opus mapping family zero")
          } else {
            if (packet.length < 16 || textAt(packet, 0, 8) !== "OpusTags")
              fail("malformed", "Invalid OpusTags")
            const tags = new DataView(packet.buffer)
            cursor = 12 + tags.getUint32(8, true)
            if (cursor + 4 > packet.length) fail("malformed", "Truncated OpusTags vendor")
            const count = tags.getUint32(cursor, true)
            cursor += 4
            if (count > 1024) fail("limit", "Too many OpusTags comments")
            for (let tag = 0; tag < count; tag++) {
              if (cursor + 4 > packet.length) fail("malformed", "Truncated OpusTags comment")
              const length = tags.getUint32(cursor, true)
              cursor += 4 + length
              if (cursor > packet.length) fail("malformed", "Truncated OpusTags value")
            }
          }
          pieces = []
        }
        if (++packets > 15002) fail("limit", "Too many Ogg Opus packets")
        packetSize = 0
      }
    }
    ended = (flags & 4) !== 0
    offset = start
  }
  if (!ended || packetSize || packets < 3) fail("malformed", "Incomplete Ogg Opus stream")
}

async function decodeAudio(
  input: AudioTranscodeRequest
): Promise<{ mono: Float32Array; rate: number }> {
  const { bytes, source } = input
  const mime = normalizeAudioMime(source.mimeType)
  let chunks: Float32Array[] = [],
    rate = 0,
    channels = 0,
    samples = 0,
    decodedBytes = 0
  const collect = (part: Decoded) => {
    if (part.errors?.length) fail("malformed", "Audio decoder reported corrupt frames")
    if (!part.channelData[0]?.length) return
    validateShape(part.sampleRate, part.channelData.length)
    if (rate && (rate !== part.sampleRate || channels !== part.channelData.length))
      fail("malformed", "Audio layout changes within the stream")
    rate = part.sampleRate
    channels = part.channelData.length
    const count = part.channelData[0].length
    if (part.channelData.some((c) => c.length !== count))
      fail("malformed", "Inconsistent audio channels")
    samples += count
    decodedBytes += count * channels * 4
    if (samples / rate > AUDIO_DURATION_LIMIT || decodedBytes > DECODED_LIMIT)
      fail("limit", "Audio duration or decoded samples exceed the limit")
    const mono = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      let sum = 0
      for (const channel of part.channelData) {
        if (!Number.isFinite(channel[i])) fail("malformed", "Audio contains non-finite samples")
        sum += channel[i]
      }
      mono[i] = Math.max(-1, Math.min(1, sum / channels))
    }
    chunks.push(mono)
  }
  if (mime === "audio/pcm") {
    validateShape(source.sampleRate ?? 0, source.channels ?? 0)
    const ch = source.channels!,
      sr = source.sampleRate!
    if (bytes.length % (2 * ch)) fail("malformed", "PCM16 data is misaligned")
    if (bytes.length / (2 * ch * sr) > AUDIO_DURATION_LIMIT || bytes.length * 2 > DECODED_LIMIT)
      fail("limit", "PCM duration or decoded samples exceed the limit")
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const planes = Array.from({ length: ch }, (_, c) =>
      Float32Array.from(
        { length: bytes.length / (2 * ch) },
        (_, i) => view.getInt16((i * ch + c) * 2, true) / 32768
      )
    )
    collect({ channelData: planes, sampleRate: sr })
  } else if (mime === "audio/silk") {
    silkFrames(bytes)
    const { decode } = await import("silk-wasm")
    const pcm = await decode(bytes, RATE)
    if (
      !pcm.data.length ||
      pcm.data.length % 2 ||
      pcm.data.length > RATE * AUDIO_DURATION_LIMIT * 2
    )
      fail("limit", "Decoded SILK exceeds the duration limit")
    const view = new DataView(pcm.data.buffer, pcm.data.byteOffset, pcm.data.byteLength)
    collect({
      channelData: [
        Float32Array.from(
          { length: pcm.data.length / 2 },
          (_, i) => view.getInt16(i * 2, true) / 32768
        ),
      ],
      sampleRate: RATE,
    })
  } else if (mime === "audio/aac" || mime === "audio/mp4") {
    const { decodeAacAudio } = await import("./aac")
    await decodeAacAudio(bytes, mime, collect)
  } else {
    let decoder: Decoder
    let encoded = bytes
    if (mime === "audio/wav") {
      encoded = validateWav(bytes)
      decoder = (await import("@audio/decode-wav")).decoder()
    } else if (mime === "audio/mpeg") {
      if (textAt(bytes, 0, 3) !== "ID3" && !(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
        fail("malformed", "Invalid MP3 header")
      decoder = await (await import("@audio/decode-mp3")).decoder()
    } else if (mime === "audio/flac") {
      if (bytes.length < 42 || textAt(bytes, 0, 4) !== "fLaC" || (bytes[4] & 127) !== 0)
        fail("malformed", "Expected native FLAC STREAMINFO")
      const sr = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4)
      const ch = ((bytes[20] >> 1) & 7) + 1
      validateShape(sr, ch)
      const bits = (((bytes[20] & 1) << 4) | (bytes[21] >> 4)) + 1
      const info = new DataView(bytes.buffer, bytes.byteOffset)
      if (bits < 8 || bits > 32 || info.getUint16(8) < 16 || info.getUint16(10) < info.getUint16(8))
        fail("malformed", "Invalid FLAC STREAMINFO layout")
      const total =
        (bytes[21] & 15) * 2 ** 32 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(22)
      if (!total) fail("unsupported", "FLAC requires a declared sample count")
      if (total / sr > AUDIO_DURATION_LIMIT || total * ch * 4 > DECODED_LIMIT)
        fail("limit", "FLAC duration or decoded samples exceed the limit")
      let end = 4,
        blocks = 0
      for (;;) {
        if (end + 4 > bytes.length) fail("malformed", "Truncated FLAC metadata")
        const type = bytes[end] & 127,
          last = (bytes[end] & 128) !== 0
        const size = bytes[end + 1] * 65536 + bytes[end + 2] * 256 + bytes[end + 3]
        if (
          type === 127 ||
          (type === 0 && (end !== 4 || size !== 34)) ||
          end + 4 + size > bytes.length
        )
          fail("malformed", "Invalid FLAC metadata block")
        end += 4 + size
        if (++blocks > 128 || end > 1_000_000) fail("limit", "FLAC metadata exceeds the limit")
        if (last) break
      }
      // Keep STREAMINFO; pictures and comment arrays are unnecessary for decoding.
      encoded = new Uint8Array(42 + bytes.length - end)
      encoded.set(bytes.subarray(0, 42))
      encoded[4] = 128
      encoded.set(bytes.subarray(end), 42)
      decoder = await (await import("@audio/decode-flac")).decoder()
    } else {
      validateOggOpus(bytes)
      decoder = await (await import("@audio/decode-opus")).decoder()
    }
    try {
      // Bound each decoder call as well as retained PCM. The enclosing Worker
      // has a hard deadline and is discarded even after success.
      for (let offset = 0; offset < encoded.length; offset += 1024)
        collect(await decoder.decode(encoded.subarray(offset, offset + 1024)))
      if (decoder.flush) collect(await decoder.flush())
    } finally {
      decoder.free()
    }
  }
  if (!samples) fail("malformed", "Audio decoder produced no samples")
  const mono = new Float32Array(samples)
  let offset = 0
  for (const chunk of chunks) {
    mono.set(chunk, offset)
    offset += chunk.length
  }
  chunks = []
  return { mono, rate }
}

/** Windowed sinc downsampling keeps speech-band energy without folding high frequencies. */
function toPcm24k(mono: Float32Array, sourceRate: number): Uint8Array {
  const count = Math.ceil((mono.length * RATE) / sourceRate)
  const bytes = new Uint8Array(count * 2),
    view = new DataView(bytes.buffer)
  const taps = 32,
    phases = 256,
    cutoff = Math.min(1, RATE / sourceRate) * 0.94
  const table = Array.from({ length: phases }, (_, phase) =>
    Float64Array.from({ length: taps }, (_, tap) => {
      const x = tap - 15 - phase / phases
      return (
        (Math.abs(x) < 1e-9 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x)) *
        (0.5 + 0.5 * Math.cos((Math.PI * x) / 16))
      )
    })
  )
  for (let i = 0; i < count; i++) {
    const position = (i * sourceRate) / RATE,
      center = Math.floor(position)
    const weights = table[Math.min(phases - 1, Math.floor((position - center) * phases))]
    let sum = 0,
      weight = 0
    for (let tap = 0; tap < taps; tap++) {
      const index = center + tap - 15
      if (index >= 0 && index < mono.length) {
        sum += mono[index] * weights[tap]
        weight += weights[tap]
      }
    }
    const sample = Math.max(-1, Math.min(1, weight ? sum / weight : 0))
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  return bytes
}
export async function transcodeAudioBytes(input: AudioTranscodeRequest): Promise<TranscodedAudio> {
  validateAudioRequest(input)
  try {
    const { mono, rate } = await decodeAudio(input)
    let pcm = toPcm24k(mono, rate)
    if (input.target === "wav")
      return {
        bytes: new Uint8Array(pcmToWav(pcm.buffer as ArrayBuffer, RATE, 1)),
        mimeType: "audio/wav",
        sampleRate: RATE,
        channels: 1,
        durationSec: pcm.length / 2 / RATE,
      }
    // Encode complete 20 ms frames; preserve the final partial frame with silence.
    const padded = new Uint8Array(Math.ceil(pcm.length / 960) * 960)
    padded.set(pcm)
    pcm = padded
    const { encode } = await import("silk-wasm")
    const result = await encode(pcm, RATE)
    const frames = silkFrames(result.data)
    if (result.data.length > AUDIO_INPUT_LIMIT)
      fail("limit", "Encoded audio exceeds the delivery limit")
    return {
      bytes: result.data,
      mimeType: "audio/silk",
      sampleRate: RATE,
      channels: 1,
      durationSec: frames / 50,
    }
  } catch (error) {
    if (error instanceof AudioTranscodeError) throw error
    const failure = new AudioTranscodeError(
      "malformed",
      "Audio codec failed to decode or encode the input"
    )
    failure.cause = error
    throw failure
  }
}
