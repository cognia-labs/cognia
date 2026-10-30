jest.mock("@wasm-audio-decoders/aac", () => ({ AACDecoder: jest.fn() }))
jest.mock("mediabunny", () => ({
  Input: jest.fn(),
  BufferSource: jest.fn(),
  EncodedPacketSink: jest.fn(),
  MP4: {},
}))
import { AACDecoder } from "@wasm-audio-decoders/aac"
import { Input, EncodedPacketSink } from "mediabunny"
import { decodeAacAudio } from "./aac"
import { inspectAdts, inspectMp4 } from "./aac"
import fixtures from "./test-audio.json"

const input = (name: keyof typeof fixtures) => new Uint8Array(Buffer.from(fixtures[name], "base64"))
function field(bytes: Uint8Array, tag: string) {
  const pos = Buffer.from(bytes).indexOf(tag)
  expect(pos).toBeGreaterThan(0)
  return { pos, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
}
it("admits complete LC/implicit HE ADTS and rejects truncated or changing transport", () => {
  expect(inspectAdts(input("aac"))).toMatchObject({ rate: 44100, channels: 2 })
  expect(inspectAdts(input("he_aac")).frames.length).toBeGreaterThan(1)
  const bytes = input("aac")
  const junk = new Uint8Array(bytes.length + 1)
  junk.set(bytes)
  expect(() => inspectAdts(junk)).toThrow(/ADTS/)
  expect(() => inspectAdts(bytes.subarray(0, bytes.length - 1))).toThrow(/ADTS/)
  const blocks = bytes.slice()
  blocks[6] |= 1
  expect(() => inspectAdts(blocks)).toThrow(/raw block/)
  const firstSize = inspectAdts(bytes).frames[0].length
  const changed = bytes.slice()
  changed[firstSize + 2] ^= 4
  expect(() => inspectAdts(changed)).toThrow(/configuration changes/)
})
it.each(["m4a", "m4a_tail", "m4a_fragmented"] as const)(
  "bounds %s tables and preserves original bytes while masking optional metadata",
  (name) => {
    const bytes = input(name),
      copy = bytes.slice(),
      result = inspectMp4(bytes)
    expect(result.packetCount).toBeGreaterThan(0)
    expect(bytes).toEqual(copy)
    const metadata = Buffer.from(bytes).indexOf("udta")
    expect(metadata).toBeGreaterThan(0)
    expect(Buffer.from(result.bytes.subarray(metadata, metadata + 4)).toString()).toBe("free")
    expect(result.bytes.length).toBe(bytes.length)
    if (name !== "m4a_fragmented") expect(result.duration).toBeCloseTo(0.4, 3)
  }
)
it.each(["stsz", "stts", "stco", "stsc"])(
  "rejects oversized %s counts before demux allocation",
  (tag) => {
    const bytes = input("m4a"),
      { pos, view } = field(bytes, tag)
    view.setUint32(pos + (tag === "stsz" ? 12 : 8), 0xffffffff)
    expect(() => inspectMp4(bytes)).toThrow(/count.*limit/)
  }
)
it("rejects inconsistent tables, invalid byte ranges, encryption and non-AAC sample entries", () => {
  const timing = input("m4a"),
    { pos, view } = field(timing, "stts")
  view.setUint32(pos + 12, 1)
  expect(() => inspectMp4(timing)).toThrow(/sample counts/)
  const offsets = input("m4a"),
    chunk = field(offsets, "stco")
  chunk.view.setUint32(chunk.pos + 12, 0)
  expect(() => inspectMp4(offsets)).toThrow(/outside media/)
  for (const tag of ["enca", "alac"]) {
    const bytes = input("m4a"),
      { pos } = field(bytes, "mp4a")
    bytes.set(Buffer.from(tag), pos)
    expect(() => inspectMp4(bytes)).toThrow(/unencrypted AAC/)
  }
})
it("rejects unsupported edit rates and box overflows rather than ignoring them", () => {
  const bytes = input("m4a"),
    { pos, view } = field(bytes, "elst")
  view.setInt32(pos + 20, 32768)
  expect(() => inspectMp4(bytes)).toThrow(/playback rate/)
  const truncated = input("m4a").subarray(0, 100)
  expect(() => inspectMp4(truncated)).toThrow(/box size/)
})

function decoderContract() {
  let index = 0
  const part = () => ({
    channelData: index++ === 0 ? [] : [new Float32Array(1024).fill(0.25)],
    sampleRate: index === 1 ? 0 : 24000,
    samplesDecoded: index === 1 ? 0 : 1024,
    errors: [],
  })
  const decoder = {
    ready: Promise.resolve(),
    decodeFrames: jest.fn(async () => part()),
    free: jest.fn(),
  }
  jest
    .mocked(AACDecoder)
    .mockClear()
    .mockImplementation(() => decoder as never)
  const packets = Array.from({ length: 11 }, (_, i) => ({
    data: new Uint8Array([1]),
    timestamp: ((i - 1) * 1024) / 24000,
    duration: i === 10 ? 0.016 : 1024 / 24000,
  }))
  const config = {
    codec: "mp4a.40.2",
    sampleRate: 24000,
    numberOfChannels: 1,
    description: new Uint8Array([19, 8, 86, 229, 0]),
  }
  const track = { codec: "aac", getDecoderConfig: jest.fn(async () => config) }
  const media = { getAudioTracks: jest.fn(async () => [track]), dispose: jest.fn() }
  jest
    .mocked(Input)
    .mockClear()
    .mockImplementation(() => media as never)
  jest
    .mocked(EncodedPacketSink)
    .mockClear()
    .mockImplementation(
      () =>
        ({
          packets: async function* () {
            yield* packets
          },
        }) as never
    )
  return { decoder, packets, config, track, media }
}
it("decodes every MP4 priming packet, clips only the last frame and releases resources", async () => {
  const { decoder, media } = decoderContract(),
    collect = jest.fn()
  await decodeAacAudio(input("m4a_tail"), "audio/mp4", collect)
  expect(decoder.decodeFrames).toHaveBeenCalledTimes(11)
  expect(collect.mock.calls.reduce((n, [part]) => n + part.channelData[0].length, 0)).toBe(9600)
  expect(collect.mock.calls.at(-1)![0].channelData[0].length).toBe(384)
  expect(decoder.free).toHaveBeenCalledTimes(1)
  expect(media.dispose).toHaveBeenCalledTimes(1)
})
it("uses the same bounded decoder contract for completely admitted ADTS", async () => {
  const { decoder } = decoderContract(),
    collect = jest.fn()
  await decodeAacAudio(input("aac"), "audio/aac", collect)
  expect(decoder.decodeFrames).toHaveBeenCalledTimes(inspectAdts(input("aac")).frames.length)
  expect(collect).toHaveBeenCalled()
  expect(Input).not.toHaveBeenCalled()
  expect(decoder.free).toHaveBeenCalledTimes(1)
})
it.each(["duration", "gap", "coverage"] as const)(
  "fails closed on %s corruption and frees the initialized decoder",
  async (kind) => {
    const { decoder, packets, media } = decoderContract()
    if (kind === "duration") packets[1].duration /= 2
    if (kind === "gap") packets[2].timestamp += 0.01
    const bytes = input("m4a_tail")
    if (kind === "coverage") {
      const { pos, view } = field(bytes, "elst")
      view.setUint32(pos + 12, 600)
    }
    await expect(decodeAacAudio(bytes, "audio/mp4", jest.fn())).rejects.toMatchObject({
      code: "malformed",
    })
    expect(decoder.free).toHaveBeenCalledTimes(1)
    expect(media.dispose).toHaveBeenCalledTimes(1)
  }
)
it("rejects a huge presentation gap before allocating silence", async () => {
  const { decoder, packets } = decoderContract()
  packets[0].timestamp = 299
  packets[1].timestamp = 299 + 1024 / 24000
  await expect(decodeAacAudio(input("m4a_tail"), "audio/mp4", jest.fn())).rejects.toMatchObject({
    code: "malformed",
  })
  expect(decoder.free).toHaveBeenCalledTimes(1)
})
it.each(["large", "profile"] as const)(
  "refuses %s codec configuration before constructing WASM",
  async (kind) => {
    const { config, media } = decoderContract()
    config.description = kind === "large" ? new Uint8Array(65) : new Uint8Array([11, 8])
    await expect(decodeAacAudio(input("m4a_tail"), "audio/mp4", jest.fn())).rejects.toMatchObject({
      code: "unsupported",
    })
    expect(AACDecoder).not.toHaveBeenCalled()
    expect(media.dispose).toHaveBeenCalledTimes(1)
  }
)
it("counts raw decoded samples before trimming and rejects changed layouts", async () => {
  const first = decoderContract()
  first.decoder.decodeFrames.mockResolvedValue({
    channelData: [new Float32Array(8_000_001), new Float32Array(8_000_001)],
    sampleRate: 24000,
    samplesDecoded: 8_000_001,
    errors: [],
  })
  await expect(decodeAacAudio(input("m4a_tail"), "audio/mp4", jest.fn())).rejects.toMatchObject({
    code: "limit",
  })
  expect(first.decoder.free).toHaveBeenCalledTimes(1)
  const second = decoderContract()
  second.decoder.decodeFrames
    .mockResolvedValueOnce({
      channelData: [new Float32Array(1024)],
      sampleRate: 24000,
      samplesDecoded: 1024,
      errors: [],
    })
    .mockResolvedValueOnce({
      channelData: [new Float32Array(1024), new Float32Array(1024)],
      sampleRate: 24000,
      samplesDecoded: 1024,
      errors: [],
    })
  await expect(decodeAacAudio(input("m4a_tail"), "audio/mp4", jest.fn())).rejects.toMatchObject({
    code: "malformed",
  })
  expect(second.decoder.free).toHaveBeenCalledTimes(1)
})
