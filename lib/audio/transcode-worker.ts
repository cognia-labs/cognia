import {
  transcodeAudioBytes,
  AudioTranscodeError,
  type AudioTranscodeRequest,
  type TranscodedAudio,
} from "./transcode-core"

export type AudioWorkerResponse =
  { result: TranscodedAudio } | { error: { code: AudioTranscodeError["code"]; message: string } }
interface WorkerScope {
  onmessage: ((event: MessageEvent<AudioTranscodeRequest>) => void) | null
  postMessage(message: AudioWorkerResponse, transfer?: Transferable[]): void
}
export function installAudioWorker(scope: WorkerScope): void {
  let started = false
  scope.onmessage = async (event) => {
    if (started) return
    started = true
    try {
      const result = await transcodeAudioBytes(event.data)
      scope.postMessage({ result }, [result.bytes.buffer as ArrayBuffer])
    } catch (error) {
      scope.postMessage({
        error: {
          code: error instanceof AudioTranscodeError ? error.code : "malformed",
          message: error instanceof AudioTranscodeError ? error.message : "Audio conversion failed",
        },
      })
    }
  }
}
// Importing the module for tests or SSR must never install a window handler.
if (
  !("document" in globalThis) &&
  typeof (globalThis as unknown as WorkerScope).postMessage === "function"
)
  installAudioWorker(globalThis as unknown as WorkerScope)
