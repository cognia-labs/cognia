/** @jest-environment node */
import { transcodeAudioBytes, AudioTranscodeError } from "./transcode-core"
import fixtures from "./test-audio.json"
import { execFileSync } from "node:child_process"

// Run real WASM outside Jest's VM: silk-wasm uses Node dynamic import.
function convert(input: Parameters<typeof transcodeAudioBytes>[0]) {
  const script = `const {transcodeAudioBytes}=require("./lib/audio/transcode-core.ts"); let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",async()=>{try{const x=JSON.parse(s);x.bytes=new Uint8Array(Buffer.from(x.bytes,"base64"));const r=await transcodeAudioBytes(x);console.log(JSON.stringify({...r,bytes:Buffer.from(r.bytes).toString("base64")}))}catch(e){console.log(JSON.stringify({error:{code:e.code,message:e.message}}))}})`
  const value = JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      input: JSON.stringify({ ...input, bytes: Buffer.from(input.bytes).toString("base64") }),
      timeout: 15000,
      maxBuffer: 2000000,
    }).toString()
  )
  if (value.error) throw new AudioTranscodeError(value.error.code, value.error.message)
  return { ...value, bytes: new Uint8Array(Buffer.from(value.bytes, "base64")) }
}

function tone(rate = 48000, channels = 2, seconds = 0.4) {
  const bytes = new Uint8Array(Math.round(rate * seconds) * channels * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < bytes.length / 2; i++)
    view.setInt16(
      i * 2,
      Math.round(12000 * Math.sin((2 * Math.PI * 440 * Math.floor(i / channels)) / rate)),
      true
    )
  return bytes
}

it("encodes real stereo PCM to Tencent SILK and decodes it to a mono WAV", async () => {
  const silk = convert({
    bytes: tone(),
    source: { mimeType: "audio/pcm", sampleRate: 48000, channels: 2 },
    target: "silk",
  })
  expect([...silk.bytes.slice(0, 10)]).toEqual([2, 35, 33, 83, 73, 76, 75, 95, 86, 51])
  expect(silk).toMatchObject({ mimeType: "audio/silk", sampleRate: 24000, channels: 1 })
  expect(silk.durationSec).toBeCloseTo(0.4, 1)
  const wav = convert({ bytes: silk.bytes, source: { mimeType: "audio/silk" }, target: "wav" })
  expect(Buffer.from(wav.bytes.slice(0, 4)).toString()).toBe("RIFF")
  const samples = new Int16Array(wav.bytes.buffer, 44)
  expect(samples.length).toBeGreaterThan(8000)
  expect(samples.reduce((sum, n) => sum + n * n, 0) / samples.length).toBeGreaterThan(1000000)
})

it("resamples WAV and rejects mislabeled, truncated or excessive input", async () => {
  const wav = convert({
    bytes: tone(),
    source: { mimeType: "audio/pcm", sampleRate: 48000, channels: 2 },
    target: "wav",
  })
  const silk = convert({ bytes: wav.bytes, source: { mimeType: "audio/wav" }, target: "silk" })
  expect(silk.durationSec).toBeCloseTo(0.4, 1)
  await expect(
    transcodeAudioBytes({ bytes: wav.bytes, source: { mimeType: "audio/mpeg" }, target: "silk" })
  ).rejects.toBeInstanceOf(AudioTranscodeError)
  await expect(
    transcodeAudioBytes({
      bytes: wav.bytes.slice(0, 50),
      source: { mimeType: "audio/wav" },
      target: "silk",
    })
  ).rejects.toThrow(/WAV/)
  await expect(
    transcodeAudioBytes({
      bytes: new Uint8Array(20_000_001),
      source: { mimeType: "audio/wav" },
      target: "silk",
    })
  ).rejects.toMatchObject({ code: "limit" })
  await expect(
    transcodeAudioBytes({
      bytes: new Uint8Array(24000 * 2 * 301),
      source: { mimeType: "audio/pcm", sampleRate: 24000, channels: 1 },
      target: "silk",
    })
  ).rejects.toMatchObject({ code: "limit" })
  await expect(
    transcodeAudioBytes({
      bytes: tone(),
      source: { mimeType: "audio/pcm", sampleRate: 0, channels: 2 },
      target: "silk",
    })
  ).rejects.toMatchObject({ code: "unsupported" })
})

// FFmpeg 8 lavfi sine=frequency=440:duration=0.4, stereo, libmp3lame/
// flac/libopus. Stored bytes keep regressions independent of host encoders.
it.each([
  ["mp3", "audio/mpeg"],
  ["flac", "audio/flac"],
  ["opus", "audio/ogg"],
] as const)("decodes real %s fixture before encoding SILK", (format, mimeType) => {
  const result = convert({
    bytes: new Uint8Array(Buffer.from(fixtures[format], "base64")),
    source: { mimeType },
    target: "silk",
  })
  expect(result.mimeType).toBe("audio/silk")
  expect(result.durationSec).toBeGreaterThanOrEqual(0.38)
  expect(result.durationSec).toBeLessThan(0.5)
  const wav = convert({ bytes: result.bytes, source: { mimeType: "audio/silk" }, target: "wav" })
  expect(wav.bytes.length).toBeGreaterThan(18000)
})

it("accepts valid WAV odd metadata padding and rejects hostile WAV layout before decoding", async () => {
  const wav = convert({
    bytes: tone(),
    source: { mimeType: "audio/pcm", sampleRate: 48000, channels: 2 },
    target: "wav",
  }).bytes
  const padded = new Uint8Array(wav.length + 10)
  padded.set(wav.subarray(0, 12))
  padded.set([74, 85, 78, 75, 1, 0, 0, 0, 42, 0], 12)
  padded.set(wav.subarray(12), 22)
  new DataView(padded.buffer).setUint32(4, padded.length - 8, true)
  expect(
    convert({ bytes: padded, source: { mimeType: "audio/wav" }, target: "silk" }).durationSec
  ).toBeCloseTo(0.4, 1)
  const hostile = wav.slice()
  new DataView(hostile.buffer).setUint16(22, 65535, true)
  await expect(
    transcodeAudioBytes({ bytes: hostile, source: { mimeType: "audio/wav" }, target: "silk" })
  ).rejects.toMatchObject({ code: "unsupported" })
  await expect(
    transcodeAudioBytes({
      bytes: new Uint8Array([2, 35, 33, 83, 73, 76, 75, 95, 86, 51, 255, 127]),
      source: { mimeType: "audio/silk" },
      target: "wav",
    })
  ).rejects.toMatchObject({ code: "malformed" })
})

it("rejects unknown FLAC duration and oversized metadata before loading a decoder", async () => {
  const flac = new Uint8Array(Buffer.from(fixtures.flac, "base64"))
  flac[21] &= 240
  flac.fill(0, 22, 26)
  await expect(
    transcodeAudioBytes({ bytes: flac, source: { mimeType: "audio/flac" }, target: "silk" })
  ).rejects.toMatchObject({ code: "unsupported" })
  flac[25] = 10
  flac[5] = 255
  await expect(
    transcodeAudioBytes({ bytes: flac, source: { mimeType: "audio/flac" }, target: "silk" })
  ).rejects.toMatchObject({ code: "malformed" })
})

it("requires structural Ogg headers and bounds comment arrays before decoding", async () => {
  const opus = new Uint8Array(Buffer.from(fixtures.opus, "base64"))
  const marker = Buffer.from(opus).indexOf("OpusTags")
  const view = new DataView(opus.buffer)
  const countOffset = marker + 12 + view.getUint32(marker + 8, true)
  view.setUint32(countOffset, 0xffffffff, true)
  await expect(
    transcodeAudioBytes({ bytes: opus, source: { mimeType: "audio/ogg" }, target: "silk" })
  ).rejects.toMatchObject({ code: "limit" })
  const fake = new Uint8Array(100)
  fake.set(Buffer.from("OggS"))
  fake.set(Buffer.from("OpusHead"), 40)
  await expect(
    transcodeAudioBytes({ bytes: fake, source: { mimeType: "audio/ogg" }, target: "silk" })
  ).rejects.toBeInstanceOf(AudioTranscodeError)
})

it.each([
  ["aac", "audio/aac"],
  ["m4a", "audio/mp4"],
  ["m4a_tail", "audio/x-m4a"],
  ["m4a_fragmented", "audio/mp4"],
  ["he_aac", "audio/aac"],
  ["he_m4a", "audio/mp4"],
] as const)("converts real %s bytes through the common AAC/M4A path", (format, mimeType) => {
  const bytes = new Uint8Array(Buffer.from(fixtures[format], "base64"))
  const wav = convert({ bytes, source: { mimeType }, target: "wav" })
  const silk = convert({ bytes, source: { mimeType }, target: "silk" })
  expect(silk.mimeType).toBe("audio/silk")
  expect([...silk.bytes.subarray(0, 10)]).toEqual([2, 35, 33, 83, 73, 76, 75, 95, 86, 51])
  const samples = new Int16Array(wav.bytes.buffer, 44)
  expect(samples.reduce((s, n) => s + n * n, 0) / samples.length).toBeGreaterThan(100000)
  if (format === "m4a" || format === "m4a_tail") expect(wav.durationSec).toBeCloseTo(0.4, 3)
  else expect(wav.durationSec).toBeGreaterThan(0.38)
  expect(silk.durationSec).toBeLessThan(0.6)
})

it("preserves M4A priming, start/end markers and trimmed presentation against FFmpeg PCM", () => {
  const wav = convert({
    bytes: new Uint8Array(Buffer.from(fixtures.m4a_markers, "base64")),
    source: { mimeType: "audio/mp4" },
    target: "wav",
  })
  const decoded = new Int16Array(wav.bytes.buffer, 44)
  const reference = Buffer.from(fixtures.m4a_markers_reference, "base64")
  expect(decoded.length).toBe(reference.length / 4)
  for (const [start, end] of [
    [0, 2400],
    [7200, 9600],
  ]) {
    let dot = 0,
      left = 0,
      right = 0
    for (let i = start; i < end; i++) {
      const a = decoded[i] / 32768,
        b = reference.readFloatLE(i * 4)
      dot += a * b
      left += a * a
      right += b * b
    }
    expect(dot / Math.sqrt(left * right)).toBeGreaterThan(0.97)
    expect(left / (end - start)).toBeGreaterThan(0.01)
  }
})

it.each([512, 2048])(
  "rejects forged MP4 frame delta %i instead of dropping speech or inserting gaps",
  (delta) => {
    const bytes = new Uint8Array(Buffer.from(fixtures.m4a, "base64")),
      index = Buffer.from(bytes).indexOf("stts")
    new DataView(bytes.buffer).setUint32(index + 16, delta)
    expect(() => convert({ bytes, source: { mimeType: "audio/mp4" }, target: "wav" })).toThrow(
      /duration|timing/
    )
  }
)
it("rejects a declared edit duration that the decoded presentation cannot cover", () => {
  const bytes = new Uint8Array(Buffer.from(fixtures.m4a, "base64")),
    index = Buffer.from(bytes).indexOf("elst")
  new DataView(bytes.buffer).setUint32(index + 12, 600)
  expect(() => convert({ bytes, source: { mimeType: "audio/mp4" }, target: "wav" })).toThrow(
    /presentation/
  )
})
