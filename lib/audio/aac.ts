/*! @license
 * Local AAC/MP4 admission and decoding, called only by the shared audio engine.
 * AACDecoder wrapper: MIT; embedded FAAD2: GPL-2.0-or-later.
 * Code from FAAD2 is copyright (c) Nero AG, www.nero.com
 * Sources/notices: docs/development/audio-codec-dependencies.md.
 */
import {
  AUDIO_INPUT_LIMIT,
  AUDIO_DURATION_LIMIT,
  DECODED_LIMIT,
  fail,
  type DecodedAudio,
} from "./formats"

const MAX_PACKETS = 32768
const MAX_PACKET_BYTES = 65536
const text = (b: Uint8Array, p: number, n: number) => String.fromCharCode(...b.subarray(p, p + n))
const RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

function shape(rate: number, channels: number) {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 48000 || ![1, 2].includes(channels))
    fail("unsupported", "AAC requires 8–48 kHz mono or stereo audio")
}

/** Validate the complete transport, including the final frame; never accept a prefix. */
export function inspectAdts(bytes: Uint8Array) {
  const frames: Uint8Array[] = []
  let offset = 0,
    signature = -1,
    rate = 0,
    channels = 0
  while (offset < bytes.length) {
    if (offset + 7 > bytes.length || bytes[offset] !== 255 || (bytes[offset + 1] & 246) !== 240)
      fail("malformed", "Invalid or truncated ADTS header")
    const profile = (bytes[offset + 2] >> 6) + 1,
      frequency = (bytes[offset + 2] >> 2) & 15
    rate = RATES[frequency] ?? 0
    channels = ((bytes[offset + 2] & 1) << 2) | (bytes[offset + 3] >> 6)
    shape(rate, channels)
    if (profile !== 2 || (bytes[offset + 6] & 3) !== 0)
      fail("unsupported", "ADTS requires AAC-LC core and one raw block per frame")
    const current = profile * 256 + frequency * 8 + channels
    if (signature >= 0 && current !== signature)
      fail("malformed", "ADTS configuration changes within the stream")
    signature = current
    const header = bytes[offset + 1] & 1 ? 7 : 9
    const size =
      ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5)
    if (size <= header || offset + size > bytes.length) fail("malformed", "Truncated ADTS frame")
    frames.push(bytes.subarray(offset, offset + size))
    if (frames.length > MAX_PACKETS || (frames.length * 1024) / rate > AUDIO_DURATION_LIMIT + 1)
      fail("limit", "AAC frame count or duration exceeds the limit")
    offset += size
  }
  if (!frames.length) fail("malformed", "AAC audio is empty")
  return { frames, rate, channels }
}

interface Box {
  type: string
  start: number
  payload: number
  end: number
}
interface SampleTable {
  count?: number
  timing?: number
  composition?: number
  sizes: number[]
  fixed?: number
  offsets: number[]
  mapping: { first: number; samples: number }[]
}
interface Mp4Admission {
  bytes: Uint8Array
  duration?: number
  leadingSilence: number
  packetCount: number
}

/** Bound all size/count-driven metadata before the container library sees it. */
export function inspectMp4(bytes: Uint8Array): Mp4Admission {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let boxes = 0,
    descriptions = 0,
    moovs = 0,
    movieScale = 0,
    fragments = 0,
    entries = 0,
    admitted = bytes
  let editDuration: number | undefined,
    leadingEditUnits = 0
  const media: { start: number; end: number }[] = [],
    tables: SampleTable[] = []
  const u64 = (p: number) => {
    const value = view.getUint32(p) * 2 ** 32 + view.getUint32(p + 4)
    if (!Number.isSafeInteger(value)) fail("limit", "MP4 integer exceeds the safe range")
    return value
  }
  const requireBytes = (p: number, size: number, end: number) => {
    if (p + size > end) fail("malformed", "Truncated MP4 table")
  }
  const count = (n: number) => {
    entries += n
    if (n > MAX_PACKETS || entries > MAX_PACKETS * 8)
      fail("limit", "MP4 table count exceeds the limit")
  }
  const walk = (start: number, end: number, depth: number, table?: SampleTable) => {
    if (depth > 12) fail("limit", "MP4 nesting exceeds the limit")
    const seen = new Set<string>()
    for (let p = start; p < end;) {
      requireBytes(p, 8, end)
      let size = view.getUint32(p),
        header = 8
      if (size === 1) {
        requireBytes(p, 16, end)
        size = u64(p + 8)
        header = 16
      }
      if (!size) size = end - p
      if (size < header || size > end - p) fail("malformed", "Invalid MP4 box size")
      const box: Box = { type: text(bytes, p + 4, 4), start: p, payload: p + header, end: p + size }
      const q = box.payload,
        length = box.end - q,
        type = box.type
      if (++boxes > 4096) fail("limit", "Too many MP4 boxes")
      if (["sinf", "senc", "tenc", "pssh", "saiz", "saio", "enca", "encv"].includes(type))
        fail("unsupported", "Encrypted MP4 audio is unsupported")
      if (["udta", "meta", "mfra"].includes(type)) {
        // Preserve byte offsets while preventing optional pictures/comments from
        // reaching an eager metadata parser. Never modify the caller's bytes.
        if (admitted === bytes) admitted = bytes.slice()
        admitted.set([102, 114, 101, 101], p + 4)
      } else if (type === "mdat") media.push({ start: q, end: box.end })
      else if (type === "mvhd" || type === "mdhd") {
        requireBytes(q, 4, box.end)
        const version = bytes[q]
        if (version > 1) fail("unsupported", "Unsupported MP4 header version")
        const scaleAt = q + (version ? 20 : 12),
          durationAt = scaleAt + 4
        requireBytes(scaleAt, version ? 12 : 8, box.end)
        const scale = view.getUint32(scaleAt),
          duration = version ? u64(durationAt) : view.getUint32(durationAt)
        if (!scale) fail("malformed", "MP4 timescale must be positive")
        if (type === "mvhd") movieScale = scale
        if (duration && duration !== 0xffffffff && duration / scale > AUDIO_DURATION_LIMIT + 1)
          fail("limit", "MP4 duration exceeds the limit")
      } else if (type === "elst") {
        requireBytes(q, 8, box.end)
        const version = bytes[q],
          n = view.getUint32(q + 4),
          width = version ? 20 : 12
        if (version > 1 || n < 1 || n > 2 || editDuration !== undefined)
          fail("unsupported", "MP4 requires a single media edit with optional leading silence")
        requireBytes(q + 8, n * width, box.end)
        let total = 0,
          nonempty = 0
        for (let i = 0; i < n; i++) {
          const at = q + 8 + i * width
          const duration = version ? u64(at) : view.getUint32(at)
          const mt = version ? at + 8 : at + 4
          const empty = version
            ? view.getInt32(mt) === -1 && view.getUint32(mt + 4) === 0xffffffff
            : view.getInt32(mt) === -1
          const mediaTime = version
            ? view.getInt32(mt) * 2 ** 32 + view.getUint32(mt + 4)
            : view.getInt32(mt)
          if (
            view.getInt32(at + (version ? 16 : 8)) !== 65536 ||
            (!empty && mediaTime < 0) ||
            (empty && i !== 0) ||
            (!empty && ++nonempty > 1)
          )
            fail("unsupported", "Unsupported MP4 edit order or playback rate")
          if (empty) leadingEditUnits = duration
          total += duration
        }
        if (nonempty !== 1 || !total) fail("unsupported", "MP4 media edit is empty")
        editDuration = total
      } else if (type === "stsd") {
        requireBytes(q, 8, box.end)
        if (view.getUint32(q + 4) !== 1 || ++descriptions !== 1)
          fail("unsupported", "MP4 requires one AAC sample description")
        requireBytes(q + 8, 8, box.end)
        if (text(bytes, q + 12, 4) !== "mp4a")
          fail("unsupported", "MP4 sample entry is not unencrypted AAC")
        walk(q + 8, box.end, depth + 1, table)
      } else if (type === "mp4a") {
        requireBytes(q, 28, box.end)
        const version = view.getUint16(q + 8)
        if (version > 1) fail("unsupported", "Unsupported MP4 audio sample entry")
        shape(view.getUint32(q + 24) >>> 16, view.getUint16(q + 16))
        walk(q + 28 + (version ? 16 : 0), box.end, depth + 1, table)
      } else if (type === "esds") {
        if (length < 8 || length > 4096) fail("limit", "AAC decoder descriptor exceeds the limit")
      } else if (type === "stbl") {
        const next: SampleTable = { sizes: [], offsets: [], mapping: [] }
        tables.push(next)
        walk(q, box.end, depth + 1, next)
      } else if (
        ["moov", "trak", "mdia", "minf", "edts", "dinf", "mvex", "moof", "traf"].includes(type)
      ) {
        if (type === "moov" && (++moovs !== 1 || size > 2_000_000))
          fail("limit", "MP4 movie metadata exceeds the limit")
        walk(q, box.end, depth + 1, table)
      } else if (type === "dref") {
        requireBytes(q, 8, box.end)
        if (view.getUint32(q + 4) !== 1)
          fail("unsupported", "External MP4 references are unsupported")
        walk(q + 8, box.end, depth + 1, table)
      } else if (type === "url " || type === "urn ") {
        requireBytes(q, 4, box.end)
        if (type !== "url " || view.getUint32(q) !== 1 || length !== 4)
          fail("unsupported", "External MP4 references are unsupported")
      } else if (type === "trun") {
        requireBytes(q, 8, box.end)
        const flags = view.getUint32(q) & 0xffffff,
          n = view.getUint32(q + 4)
        count(n)
        fragments += n
        const prefix = 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0)
        const width = [256, 512, 1024, 2048].filter((flag) => flags & flag).length * 4
        requireBytes(q + prefix, width * n, box.end)
      } else if (
        table &&
        ["stts", "ctts", "stsz", "stz2", "stsc", "stco", "co64", "stss"].includes(type)
      ) {
        if (
          seen.has(type) ||
          (["stsz", "stz2"].includes(type) && (seen.has("stsz") || seen.has("stz2")))
        )
          fail("malformed", "Duplicate MP4 sample table")
        seen.add(type)
        requireBytes(q, 8, box.end)
        if (type === "stsz" || type === "stz2") {
          requireBytes(q, 12, box.end)
          const n = view.getUint32(q + 8)
          count(n)
          table.count = n
          if (type === "stsz") {
            const fixed = view.getUint32(q + 4)
            table.fixed = fixed
            if (!fixed) {
              requireBytes(q + 12, n * 4, box.end)
              for (let i = 0; i < n; i++) table.sizes.push(view.getUint32(q + 12 + i * 4))
            }
          } else {
            const bits = bytes[q + 7]
            if (![4, 8, 16].includes(bits)) fail("malformed", "Invalid compact MP4 sample size")
            requireBytes(q + 12, Math.ceil((n * bits) / 8), box.end)
            for (let i = 0; i < n; i++)
              table.sizes.push(
                bits === 4
                  ? (bytes[q + 12 + (i >> 1)] >> (i % 2 ? 0 : 4)) & 15
                  : bits === 8
                    ? bytes[q + 12 + i]
                    : view.getUint16(q + 12 + i * 2)
              )
          }
        } else {
          const n = view.getUint32(q + 4)
          count(n)
          const width = type === "stsc" ? 12 : ["stts", "ctts", "co64"].includes(type) ? 8 : 4
          requireBytes(q + 8, n * width, box.end)
          let total = 0
          for (let i = 0; i < n; i++) {
            const at = q + 8 + i * width
            if (type === "stts" || type === "ctts") {
              total += view.getUint32(at)
              if (total > MAX_PACKETS) fail("limit", "MP4 expanded sample count exceeds the limit")
              if (type === "stts" && !view.getUint32(at + 4))
                fail("malformed", "MP4 sample duration is zero")
            } else if (type === "stco" || type === "co64")
              table.offsets.push(type === "co64" ? u64(at) : view.getUint32(at))
            else if (type === "stsc") {
              const first = view.getUint32(at),
                samples = view.getUint32(at + 4)
              if (
                !first ||
                !samples ||
                samples > MAX_PACKETS ||
                view.getUint32(at + 8) !== 1 ||
                (i ? first <= table.mapping[i - 1].first : first !== 1)
              )
                fail("malformed", "Invalid MP4 sample-to-chunk mapping")
              table.mapping.push({ first, samples })
            }
          }
          if (type === "stts") table.timing = total
          if (type === "ctts") table.composition = total
        }
      }
      p = box.end
    }
  }
  if (bytes.length < 12 || text(bytes, 4, 4) !== "ftyp")
    fail("malformed", "Expected MP4/M4A container")
  walk(0, bytes.length, 0)
  if (moovs !== 1 || descriptions !== 1 || !movieScale || !media.length || tables.length !== 1)
    fail("unsupported", "MP4 requires one self-contained AAC audio track")
  const table = tables[0],
    n = table.count ?? 0
  if (table.timing !== n || (table.composition !== undefined && table.composition !== n))
    fail("malformed", "Inconsistent MP4 sample counts")
  let sample = 0,
    mapping = 0
  for (let chunk = 0; chunk < table.offsets.length; chunk++) {
    while (mapping + 1 < table.mapping.length && table.mapping[mapping + 1].first <= chunk + 1)
      mapping++
    const count = table.mapping[mapping]?.samples ?? 0
    if (!count || sample + count > n) fail("malformed", "Incomplete MP4 chunk mapping")
    let offset = table.offsets[chunk]
    for (let i = 0; i < count; i++) {
      const size = table.fixed || table.sizes[sample++]
      // A fixed sample size must still advance the sample index.
      if (table.fixed) sample++
      if (
        !size ||
        size > MAX_PACKET_BYTES ||
        !media.some((m) => offset >= m.start && offset + size <= m.end)
      )
        fail("malformed", "MP4 sample points outside media data")
      offset += size
    }
  }
  if (sample !== n || n + fragments < 1 || n + fragments > MAX_PACKETS)
    fail("malformed", "MP4 sample table is incomplete")
  const duration = editDuration === undefined ? undefined : editDuration / movieScale
  if (duration !== undefined && duration > AUDIO_DURATION_LIMIT)
    fail("limit", "MP4 edit duration exceeds the limit")
  return {
    bytes: admitted,
    duration,
    leadingSilence: leadingEditUnits / movieScale,
    packetCount: n + fragments,
  }
}

function validateConfig(bytes: Uint8Array) {
  if (bytes.length < 2 || bytes.length > 64)
    fail("unsupported", "Invalid AAC AudioSpecificConfig size")
  let bit = 0
  const read = (n: number) => {
    if (bit + n > bytes.length * 8) fail("malformed", "Truncated AAC AudioSpecificConfig")
    let value = 0
    for (let i = 0; i < n; i++, bit++)
      value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1)
    return value
  }
  const object = read(5),
    index = read(4),
    rate = index === 15 ? read(24) : (RATES[index] ?? 0),
    channels = read(4)
  shape(rate, channels)
  if (![2, 5, 29].includes(object))
    fail("unsupported", "Only AAC-LC and HE-AAC configurations are supported")
  if (object === 5 || object === 29) {
    const extension = read(4)
    shape(extension === 15 ? read(24) : (RATES[extension] ?? 0), channels)
    if (read(5) !== 2) fail("unsupported", "HE-AAC requires an AAC-LC core")
  }
}

export async function decodeAacAudio(
  bytes: Uint8Array,
  mime: string,
  collect: (part: DecodedAudio) => void
): Promise<void> {
  if (!bytes.length || bytes.length > AUDIO_INPUT_LIMIT)
    fail("limit", "AAC input exceeds the limit")
  const mp4 = text(bytes, 4, 4) === "ftyp"
  if (mime === "audio/mp4" && !mp4) fail("malformed", "Expected MP4/M4A container")
  const adts = mp4 ? undefined : inspectAdts(bytes)
  const admitted = mp4 ? inspectMp4(bytes) : undefined
  const { AACDecoder } = await import("@wasm-audio-decoders/aac")
  let input: import("mediabunny").Input | undefined
  let decoder: InstanceType<typeof AACDecoder> | undefined
  let rawBytes = 0,
    outputBytes = 0,
    cursor = 0,
    outputRate = 0,
    outputChannels = 0
  let priming: { timestamp: number; duration: number } | undefined
  const accept = (part: DecodedAudio, timestamp?: number, duration?: number, last = false) => {
    if (part.errors?.length) fail("malformed", "AAC decoder reported corrupt frames")
    const samples = part.channelData[0]?.length ?? 0
    if (!samples) {
      // FAAD2 consumes one initial frame without emitting PCM. That packet
      // still needs valid timing; it is not an arbitrary silence directive.
      if (timestamp !== undefined) {
        if (outputRate || priming) fail("malformed", "Unexpected empty AAC frame")
        priming = { timestamp, duration: duration! }
      }
      return
    }
    shape(part.sampleRate, part.channelData.length)
    rawBytes += samples * part.channelData.length * 4
    if (rawBytes > DECODED_LIMIT) fail("limit", "AAC decoded samples exceed the limit")
    if (
      outputRate &&
      (part.sampleRate !== outputRate || part.channelData.length !== outputChannels)
    )
      fail("malformed", "AAC audio layout changes within the stream")
    outputRate = part.sampleRate
    outputChannels = part.channelData.length
    const emit = (channelData: Float32Array[]) => {
      const count = channelData[0].length
      outputBytes += count * outputChannels * 4
      cursor += count
      if (outputBytes > DECODED_LIMIT || cursor / outputRate > AUDIO_DURATION_LIMIT)
        fail("limit", "AAC presentation exceeds the limit")
      collect({ channelData, sampleRate: outputRate })
    }
    if (timestamp === undefined) {
      emit(part.channelData)
      return
    }
    const start = Math.round(timestamp * outputRate),
      declared = Math.round((duration ?? 0) * outputRate)
    if (
      (!last && Math.abs(declared - samples) > 1) ||
      declared > samples + 1 ||
      (priming && Math.abs(priming.duration * outputRate - samples) > 1)
    )
      fail("malformed", "AAC packet duration does not match decoded samples")
    const end = Math.min(
      start + Math.min(samples, declared),
      Math.round((admitted?.duration ?? AUDIO_DURATION_LIMIT) * outputRate)
    )
    if ((start >= 0 && start < cursor - 1) || !Number.isFinite(start) || !Number.isFinite(end))
      fail("malformed", "AAC presentation timestamps overlap or are invalid")
    const from = Math.max(0, cursor - start),
      until = Math.max(0, end - start)
    if (until <= from) return
    if (start > cursor) {
      const gap = start - cursor
      const initialEnd = Math.max(
        admitted?.leadingSilence ?? 0,
        priming ? priming.timestamp + priming.duration : 0
      )
      if (cursor || start > Math.round(initialEnd * outputRate) + 1)
        fail("malformed", "AAC presentation contains an unsupported timing gap")
      if (
        gap / outputRate > AUDIO_DURATION_LIMIT ||
        outputBytes + gap * outputChannels * 4 > DECODED_LIMIT
      )
        fail("limit", "AAC presentation gap exceeds the limit")
      emit(Array.from({ length: outputChannels }, () => new Float32Array(gap)))
    }
    emit(part.channelData.map((channel) => channel.subarray(from, until)))
  }
  try {
    if (adts) {
      decoder = new AACDecoder()
      await decoder.ready
      for (const frame of adts.frames) accept(await decoder.decodeFrames([frame]))
    } else {
      const { Input, BufferSource, MP4, EncodedPacketSink } = await import("mediabunny")
      input = new Input({ source: new BufferSource(admitted!.bytes), formats: [MP4] })
      const tracks = await input.getAudioTracks()
      if (tracks.length !== 1 || tracks[0].codec !== "aac")
        fail("unsupported", "MP4 track is not AAC audio")
      const track = tracks[0],
        config = await track.getDecoderConfig()
      if (!config || !config.description)
        fail("malformed", "MP4 AAC decoder configuration is missing")
      shape(config.sampleRate, config.numberOfChannels)
      const asc = ArrayBuffer.isView(config.description)
        ? new Uint8Array(
            config.description.buffer,
            config.description.byteOffset,
            config.description.byteLength
          )
        : new Uint8Array(config.description)
      validateConfig(asc)
      decoder = new AACDecoder({ audioSpecificConfig: asc })
      await decoder.ready
      let packets = 0,
        lastTimestamp = -Infinity
      for await (const packet of new EncodedPacketSink(track).packets()) {
        if (
          ++packets > admitted!.packetCount ||
          !packet.data.length ||
          packet.data.length > MAX_PACKET_BYTES
        )
          fail("limit", "AAC packet exceeds the limit")
        if (
          !Number.isFinite(packet.timestamp) ||
          !Number.isFinite(packet.duration) ||
          packet.duration <= 0 ||
          packet.timestamp < lastTimestamp ||
          packet.timestamp < -1 ||
          packet.timestamp + packet.duration > AUDIO_DURATION_LIMIT + 1
        )
          fail("malformed", "Invalid AAC packet timing")
        lastTimestamp = packet.timestamp
        accept(
          await decoder.decodeFrames([packet.data]),
          packet.timestamp,
          packet.duration,
          packets === admitted!.packetCount
        )
      }
      if (packets !== admitted!.packetCount) fail("malformed", "MP4 packets were truncated")
    }
    if (!cursor) fail("malformed", "AAC decoder produced no audible presentation")
    // Movie edit durations can be rounded to milliseconds independently of
    // the audio timescale. Larger uncovered intervals must never disappear.
    if (
      admitted?.duration !== undefined &&
      Math.abs(cursor / outputRate - admitted.duration) > 0.002 + 1 / outputRate
    )
      fail("malformed", "AAC samples do not cover the declared presentation")
  } finally {
    decoder?.free()
    input?.dispose()
  }
}
