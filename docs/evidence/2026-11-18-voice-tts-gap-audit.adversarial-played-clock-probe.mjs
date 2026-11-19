import assert from "node:assert/strict"
import { PcmPlayer } from "../../packages/tts/src/streaming/pcm-player.ts"

const sources = []
const context = {
  currentTime: 0,
  state: "running",
  destination: {},
  createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
  createBuffer: (_, length) => ({ getChannelData: () => new Float32Array(length) }),
  createBufferSource: () => {
    const source = {
      buffer: null,
      onended: null,
      startAt: null,
      connect() {},
      disconnect() {},
      start(time) {
        this.startAt = time
      },
      stop() {},
    }
    sources.push(source)
    return source
  },
  async suspend() {},
  async resume() {},
  async close() {},
}
const player = new PcmPlayer({
  sampleRate: 24000,
  audioContextFactory: () => context,
  keepAlive: true,
})
player.enqueue(new ArrayBuffer(48000))
context.currentTime = 1
sources[0].onended()
// Same response remains open, but the next network delta is delayed.
context.currentTime = 10
player.enqueue(new ArrayBuffer(48000))
context.currentTime = 10.1
assert.deepEqual(
  sources.map((source) => source.startAt),
  [0, 10]
)
assert.equal(player.playedSeconds(), 2)
const expectedHeardSeconds = 1 + (context.currentTime - sources[1].startAt)
assert.ok(Math.abs(expectedHeardSeconds - 1.1) < 0.001)
console.log(
  JSON.stringify({
    probe: "starvation-gap-counted-as-heard-audio",
    scheduledIntervals: [
      [0, 1],
      [10, 11],
    ],
    now: context.currentTime,
    reportedHeardSeconds: player.playedSeconds(),
    actualScheduledAudioElapsed: expectedHeardSeconds,
  })
)
player.stop()
