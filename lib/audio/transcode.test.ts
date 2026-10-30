import { createAudioTranscoder, type AudioWorker } from "./transcode"

function setup(timeout = 1000) {
  const worker: AudioWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: jest.fn(),
    terminate: jest.fn(),
  }
  return { worker, convert: createAudioTranscoder(() => worker, timeout) }
}
const request = () => ({
  bytes: new Uint8Array([1, 2]),
  source: { mimeType: "audio/pcm", sampleRate: 24000, channels: 1 },
  target: "silk" as const,
})
it("transfers an independent byte snapshot, terminates after success and can run again", async () => {
  const { worker, convert } = setup()
  const input = request(),
    promise = convert(input)
  const sent = jest.mocked(worker.postMessage).mock.calls[0][0]
  expect(sent.bytes).not.toBe(input.bytes)
  expect(sent.bytes).toEqual(input.bytes)
  worker.onmessage!({
    data: {
      result: {
        bytes: new Uint8Array([2, 3]),
        mimeType: "audio/silk",
        channels: 1,
        sampleRate: 24000,
        durationSec: 1,
      },
    },
  } as MessageEvent)
  expect((await promise).mimeType).toBe("audio/silk")
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  const second = convert(request())
  worker.onerror!({} as ErrorEvent)
  await expect(second).rejects.toMatchObject({ code: "unavailable" })
})
it("bounds concurrency and kills work on cancellation before any late result", async () => {
  const { worker, convert } = setup()
  const controller = new AbortController(),
    promise = convert({ ...request(), signal: controller.signal })
  await expect(convert(request())).rejects.toMatchObject({ code: "busy" })
  controller.abort()
  await expect(promise).rejects.toMatchObject({ name: "AbortError" })
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  await expect(convert({ ...request(), signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(worker.postMessage).toHaveBeenCalledTimes(1)
})
it("enforces a deadline and rejects invalid worker metadata", async () => {
  jest.useFakeTimers()
  try {
    const { worker, convert } = setup(20)
    const pending = convert(request())
    const check = expect(pending).rejects.toMatchObject({ code: "timeout" })
    jest.advanceTimersByTime(20)
    await check
    const invalid = convert(request())
    worker.onmessage!({
      data: { result: { bytes: new Uint8Array([1]), mimeType: "audio/mpeg", durationSec: 1 } },
    } as MessageEvent)
    await expect(invalid).rejects.toMatchObject({ code: "malformed" })
    expect(worker.terminate).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})
