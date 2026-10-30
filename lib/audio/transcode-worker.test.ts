jest.mock("./transcode-core", () => ({
  ...jest.requireActual("./transcode-core"),
  transcodeAudioBytes: jest.fn(),
}))
import { installAudioWorker } from "./transcode-worker"
import { transcodeAudioBytes, AudioTranscodeError } from "./transcode-core"

it("handles one byte conversion and transfers the result buffer", async () => {
  const result = {
    bytes: new Uint8Array([2]),
    mimeType: "audio/silk" as const,
    channels: 1 as const,
    sampleRate: 24000 as const,
    durationSec: 1,
  }
  jest.mocked(transcodeAudioBytes).mockResolvedValue(result)
  const scope = { onmessage: null, postMessage: jest.fn() } as Parameters<
    typeof installAudioWorker
  >[0] & { postMessage: jest.Mock }
  installAudioWorker(scope)
  const event = {
    data: { bytes: new Uint8Array([1]), source: { mimeType: "audio/wav" }, target: "silk" },
  } as MessageEvent
  await scope.onmessage!(event)
  await scope.onmessage!(event)
  expect(scope.postMessage).toHaveBeenCalledWith({ result }, [result.bytes.buffer])
  expect(scope.postMessage).toHaveBeenCalledTimes(1)
})
it("returns typed codec failures without echoing audio bytes", async () => {
  jest.mocked(transcodeAudioBytes).mockRejectedValue(new AudioTranscodeError("limit", "Too long"))
  const scope = { onmessage: null, postMessage: jest.fn() } as Parameters<
    typeof installAudioWorker
  >[0] & { postMessage: jest.Mock }
  installAudioWorker(scope)
  await scope.onmessage!({ data: {} } as MessageEvent)
  expect(scope.postMessage).toHaveBeenCalledWith({ error: { code: "limit", message: "Too long" } })
})
