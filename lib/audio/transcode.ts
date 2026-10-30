/** Public audio entry: only bytes cross the disposable, deadline-bound Worker. */
import {
  AudioTranscodeError,
  validateAudioRequest,
  AUDIO_INPUT_LIMIT,
  type AudioTranscodeRequest,
  type TranscodedAudio,
} from "./transcode-core"
import type { AudioWorkerResponse } from "./transcode-worker"
export { canTranscodeAudio, normalizeAudioMime, AudioTranscodeError } from "./transcode-core"
export type { AudioSource, AudioTarget, TranscodedAudio } from "./transcode-core"

export interface AudioWorker {
  onmessage: ((event: MessageEvent<AudioWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
  postMessage(request: AudioTranscodeRequest, transfer: Transferable[]): void
  terminate(): void
}
export function createAudioTranscoder(factory: () => AudioWorker, timeoutMs = 30_000) {
  let active = false
  return async (
    input: AudioTranscodeRequest & { signal?: AbortSignal }
  ): Promise<TranscodedAudio> => {
    input.signal?.throwIfAborted()
    validateAudioRequest(input)
    if (active) throw new AudioTranscodeError("busy", "Another audio conversion is running")
    active = true
    let worker: AudioWorker
    try {
      worker = factory()
    } catch {
      active = false
      throw new AudioTranscodeError("unavailable", "Local audio conversion requires a Web Worker")
    }
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (result?: TranscodedAudio, error?: unknown) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", abort)
        worker.terminate()
        active = false
        if (result) resolve(result)
        else reject(error)
      }
      const abort = () =>
        finish(undefined, input.signal?.reason ?? new DOMException("Aborted", "AbortError"))
      const timer = setTimeout(
        () => finish(undefined, new AudioTranscodeError("timeout", "Audio conversion timed out")),
        timeoutMs
      )
      worker.onerror = () =>
        finish(undefined, new AudioTranscodeError("unavailable", "Audio worker failed"))
      worker.onmessageerror = () =>
        finish(undefined, new AudioTranscodeError("malformed", "Invalid audio worker response"))
      worker.onmessage = ({ data }) => {
        if (data && "result" in data) {
          const r = data.result
          if (
            !(r?.bytes instanceof Uint8Array) ||
            !r.bytes.length ||
            r.bytes.length > AUDIO_INPUT_LIMIT ||
            r.mimeType !== `audio/${input.target}` ||
            r.channels !== 1 ||
            r.sampleRate !== 24000 ||
            !Number.isFinite(r.durationSec) ||
            r.durationSec <= 0 ||
            r.durationSec > 300
          ) {
            finish(undefined, new AudioTranscodeError("malformed", "Invalid converted audio"))
            return
          }
          finish(r)
        } else
          finish(
            undefined,
            new AudioTranscodeError(
              data && "error" in data ? data.error.code : "malformed",
              data && "error" in data ? data.error.message : "Audio conversion failed"
            )
          )
      }
      input.signal?.addEventListener("abort", abort, { once: true })
      if (input.signal?.aborted) {
        abort()
        return
      }
      // Copy so cancellation or transfer never detaches the TTS cache's bytes.
      try {
        const bytes = input.bytes.slice()
        worker.postMessage({ bytes, source: { ...input.source }, target: input.target }, [
          bytes.buffer,
        ])
      } catch (error) {
        finish(undefined, error)
      }
    })
  }
}
export const transcodeAudio = createAudioTranscoder(
  () =>
    new Worker(new URL("./transcode-worker.ts", import.meta.url), {
      type: "module",
      name: "cognia-audio",
    })
)
