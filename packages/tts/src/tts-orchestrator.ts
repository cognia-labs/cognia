/**
 * TTS orchestrator — the one owner of read-aloud playback.
 *
 * Every provider is either the Web Speech system voice or an HTTP adapter that
 * returns a finished audio buffer (`providers/registry.ts`). The orchestrator
 * adds what playback needs on top: text normalization, chunking, the IndexedDB
 * cache, retry, cloud → system fallback, and one request at a time.
 *
 * Privacy order: text is screened as the caller wrote it, BEFORE
 * normalization. Normalization rewrites `@` to " at ", so screening only the
 * normalized form let `alice@example.com` leave the device as
 * `alice at example.com`. The normalized chunk is screened again before it is
 * sent, and a system voice the platform reports as remote is screened too.
 */

import { getTtsHost } from "./host"

import { runChunkPipeline } from "./chunk-pipeline"
import { withTtsRetry } from "./retry"
import { generateCacheKey, getCachedTtsResponseOrGenerate } from "./tts-cache"
import { getProviderRuntimeOptions, toTTSSettings } from "./speech-settings"
import {
  applyPronunciationDictionary,
  detectLanguage,
  preprocessTextForProvider,
  splitTextForTTS,
} from "./tts-text-utils"
import { SentenceStreamSplitter, type StreamSplitterOptions } from "./stream-splitter"
import {
  DEFAULT_SPEECH_SETTINGS,
  TTS_PROVIDERS,
  normalizeTTSProvider,
  type ProviderSettingsMap,
  type SpeechSettings,
  type TTSPlaybackState,
  type TTSProvider,
  type TTSResponse,
  ttsFailure,
} from "./types"

import { getAdapter } from "./providers/registry"

/** Whether `text` may reach `provider`. On-device providers need no cloud gate. */
function allowsOutboundText(provider: TTSProvider, text: string): boolean {
  if (provider === "system" || provider === "local-openai-compatible") return true
  return getTtsHost().allowCloudText?.(text, provider) === true
}

/** Whether `text` may reach a system voice the platform runs as a remote service. */
function allowsRemoteSystemVoiceText(text: string): boolean {
  return getTtsHost().allowCloudText?.(text, "system") === true
}

export type TTSActiveSource = "chat" | "chat-widget" | "selection" | "settings" | "pet" | "unknown"

export interface TTSOrchestratorState {
  playbackState: TTSPlaybackState
  progress: number
  error: string | null
  isLoading: boolean
  isPlaying: boolean
  isPaused: boolean
  /**
   * The provider producing the audio being heard. It starts as the requested
   * provider and switches to `system` when a cloud failure falls back to the
   * system voice, so the UI names what is actually speaking.
   */
  currentProvider: TTSProvider
  activeRequestId?: string
  activeSource?: TTSActiveSource
  /**
   * Opaque caller-supplied id for the surface that owns the active playback
   * (e.g. a chat message id). Lets consumers tell whether *they* are the
   * current speaker without reaching for the internal requestId. Set on
   * loading, cleared on stop/end/error.
   */
  activeSourceId?: string
}

export interface TTSOrchestratorSpeakOptions {
  provider?: TTSProvider
  source?: TTSActiveSource
  /** Opaque id for the calling surface (e.g. chat message id). */
  sourceId?: string
  speechSettings?: SpeechSettings
  providerSettings?: ProviderSettingsMap
  onStart?: () => void
  onEnd?: () => void
  onError?: (error: string) => void
  onProgress?: (progress: number) => void
  /** Tuning for the incremental splitter used by `speakStream`. */
  splitterOptions?: StreamSplitterOptions
}

export interface TTSSynthesisOptions extends Pick<
  TTSOrchestratorSpeakOptions,
  "provider" | "speechSettings" | "providerSettings"
> {
  signal?: AbortSignal
  /** Additional sink policy, including local/cached audio exported elsewhere. */
  approveText?: (text: string) => boolean
}
export type TTSSynthesisResult = TTSResponse & {
  provider: TTSProvider
  billedCharacters: number
  spokenText?: string
}

type Subscriber = (state: TTSOrchestratorState) => void

const DEFAULT_STATE: TTSOrchestratorState = {
  playbackState: "idle",
  progress: 0,
  error: null,
  isLoading: false,
  isPlaying: false,
  isPaused: false,
  currentProvider: "system",
  activeSource: "unknown",
}

const PII_BLOCKED_MESSAGE = ttsFailure("pii-blocked").error

export class TTSOrchestrator {
  private state: TTSOrchestratorState = { ...DEFAULT_STATE }
  private subscribers = new Set<Subscriber>()
  private audioRef: HTMLAudioElement | null = null
  private audioUrlRef: string | null = null
  /** Settles the pending `playAudioResponse` promise; `stop()` calls it. */
  private finishAudio: (() => void) | null = null
  /** A system-voice utterance is queued or speaking for the active request. */
  private systemSpeaking = false
  private activeRequestId: string | null = null
  private bufferedAbort: AbortController | null = null

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber(this.state)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  getState(): TTSOrchestratorState {
    return this.state
  }

  /** Generate one encoded audio file without taking ownership of playback. */
  async synthesize(text: string, options: TTSSynthesisOptions = {}): Promise<TTSSynthesisResult> {
    const speechSettings = options.speechSettings ?? DEFAULT_SPEECH_SETTINGS
    const provider = normalizeTTSProvider(options.provider ?? speechSettings.ttsProvider)
    const failure = (response: TTSResponse): TTSSynthesisResult => ({
      ...response,
      provider,
      billedCharacters: 0,
    })
    if (getAdapter(provider).kind !== "http") return failure(ttsFailure("not-supported"))
    if (!allowsOutboundText(provider, text)) return failure(ttsFailure("pii-blocked"))
    let chunk = preprocessTextForProvider(text, provider)
    if (speechSettings.ttsPronunciationDictionary)
      chunk = applyPronunciationDictionary(chunk, speechSettings.ttsPronunciationDictionary)
    if (options.approveText && !options.approveText(chunk))
      return failure(ttsFailure("pii-blocked"))
    if (!chunk.trim() || chunk.length > TTS_PROVIDERS[provider].maxTextLength)
      return failure(ttsFailure("text-too-long"))
    let billedCharacters = 0
    const response = await this.generateChunkAudio({
      provider,
      chunk,
      speechSettings,
      providerSettings: options.providerSettings,
      signal: options.signal ?? new AbortController().signal,
      requestId: crypto.randomUUID(),
      onGenerated: () => {
        billedCharacters = chunk.length
      },
    })
    return { ...response, provider, billedCharacters, spokenText: chunk }
  }

  async speak(text: string, options: TTSOrchestratorSpeakOptions = {}): Promise<void> {
    const speechSettings = options.speechSettings ?? DEFAULT_SPEECH_SETTINGS
    const providerSettings = options.providerSettings
    const requestedProvider = normalizeTTSProvider(options.provider ?? speechSettings.ttsProvider)
    const provider = getTtsHost().isMobileShell?.() ? "system" : requestedProvider
    const source = options.source ?? "unknown"
    const sourceId = options.sourceId

    if (!speechSettings.ttsEnabled) {
      this.setState({
        playbackState: "stopped",
        isLoading: false,
        isPlaying: false,
        isPaused: false,
        error: null,
        progress: 0,
      })
      return
    }

    this.stop()

    const requestId = this.createRequestId()
    this.activeRequestId = requestId
    this.setState({
      playbackState: "loading",
      isLoading: true,
      isPlaying: false,
      isPaused: false,
      progress: 0,
      error: null,
      currentProvider: provider,
      activeRequestId: requestId,
      activeSource: source,
      activeSourceId: sourceId,
    })

    // Screen what the caller wrote before normalization can disguise it. A
    // blocked text never reaches the provider; with fallback on it is read by
    // the system voice instead, exactly like any other cloud failure.
    const sourceAllowed = allowsOutboundText(provider, text)
    const remoteVoiceAllowed = allowsRemoteSystemVoiceText(text)
    let normalizedText = preprocessTextForProvider(text, provider)
    const dict = speechSettings.ttsPronunciationDictionary
    if (dict && Object.keys(dict).length > 0) {
      normalizedText = applyPronunciationDictionary(normalizedText, dict)
    }

    const bufferedAbort = new AbortController()
    this.bufferedAbort = bufferedAbort

    const chunks = splitTextForTTS(normalizedText, provider)

    try {
      options.onStart?.()

      const chunkProgress = (index: number) => {
        const base = index / chunks.length
        const weight = 1 / chunks.length
        return (p: number) => this.updateProgress(base + p * weight, options.onProgress)
      }

      if (provider === "system") {
        for (let index = 0; index < chunks.length; index++) {
          if (!this.isCurrentRequest(requestId)) return
          await this.playSystemChunk(
            chunks[index],
            speechSettings,
            requestId,
            chunkProgress(index),
            remoteVoiceAllowed
          )
        }
      } else {
        // Cloud providers: optionally prefetch chunk i+1 while chunk i plays so
        // the network round-trip overlaps playback (the `ttsStreamingEnabled`
        // optimization). With it off, behavior is the old sequential loop.
        let consumedCount = 0
        try {
          await runChunkPipeline<TTSResponse>({
            count: chunks.length,
            isCancelled: () => !this.isCurrentRequest(requestId),
            prefetch: speechSettings.ttsStreamingEnabled,
            produce: (index) =>
              sourceAllowed
                ? this.generateChunkAudio({
                    provider,
                    chunk: chunks[index],
                    speechSettings,
                    providerSettings,
                    signal: bufferedAbort.signal,
                    requestId,
                  })
                : Promise.resolve(ttsFailure("pii-blocked")),
            consume: async (response, index) => {
              if (!response.success || !response.audioData) {
                throw new Error(
                  response.providerMessage || response.error || "Failed to generate speech audio"
                )
              }
              await this.playAudioResponse(
                response,
                provider,
                requestId,
                speechSettings.ttsVolume,
                chunkProgress(index)
              )
              consumedCount = index + 1
            },
          })
        } catch (cloudError) {
          // Fall back to the free system voice for the remaining chunks rather
          // than failing the whole utterance. Already-played chunks are skipped.
          if (!speechSettings.ttsFallbackEnabled || !this.isCurrentRequest(requestId)) {
            throw cloudError
          }
          getTtsHost().notify?.message("TTS provider failed — falling back to the system voice.")
          for (let index = consumedCount; index < chunks.length; index++) {
            if (!this.isCurrentRequest(requestId)) return
            await this.playSystemChunk(
              chunks[index],
              speechSettings,
              requestId,
              chunkProgress(index),
              remoteVoiceAllowed
            )
          }
        }
      }

      if (this.isCurrentRequest(requestId)) {
        this.setState({
          playbackState: "stopped",
          isLoading: false,
          isPlaying: false,
          isPaused: false,
          progress: 1,
          activeRequestId: undefined,
          activeSource: undefined,
          activeSourceId: undefined,
        })
        options.onEnd?.()
      }
    } catch (error) {
      if (!this.isCurrentRequest(requestId)) return
      this.failRequest(error, options)
      throw error
    } finally {
      if (this.bufferedAbort === bufferedAbort) this.bufferedAbort = null
      if (this.isCurrentRequest(requestId)) {
        this.activeRequestId = null
      }
    }
  }

  /**
   * Speak a *streaming* text source — e.g. the assistant's tokens as they are
   * generated. Fragments are cut by the incremental splitter as text arrives
   * and synthesized/played strictly in order, so the first audio starts before
   * the whole reply is written (unlike `speak()`, whose first audio waits for
   * the complete text). `speak(string)` is retained for callers that already
   * hold the finished text.
   *
   * Each fragment is screened as written, together with the fragment before it
   * so an item spanning a boundary is still seen whole, then normalized and cut
   * to the provider's input limit. A fragment that fails stops the request at
   * once — the token source is released rather than drained — and `stop()`
   * likewise stops consumption immediately.
   *
   * Per-fragment normalization is best-effort: markdown that straddles a
   * fragment boundary (e.g. a code fence) can't be stripped as cleanly as when
   * the whole text is known — an accepted trade for the latency win.
   */
  async speakStream(
    tokens: AsyncIterable<string>,
    options: TTSOrchestratorSpeakOptions = {}
  ): Promise<void> {
    const speechSettings = options.speechSettings ?? DEFAULT_SPEECH_SETTINGS
    const providerSettings = options.providerSettings
    const requestedProvider = normalizeTTSProvider(options.provider ?? speechSettings.ttsProvider)
    const provider = getTtsHost().isMobileShell?.() ? "system" : requestedProvider
    const source = options.source ?? "unknown"
    const sourceId = options.sourceId

    if (!speechSettings.ttsEnabled) return

    this.stop()
    const requestId = this.createRequestId()
    this.activeRequestId = requestId
    this.setState({
      playbackState: "loading",
      isLoading: true,
      isPlaying: false,
      isPaused: false,
      progress: 0,
      error: null,
      currentProvider: provider,
      activeRequestId: requestId,
      activeSource: source,
      activeSourceId: sourceId,
    })
    const bufferedAbort = new AbortController()
    this.bufferedAbort = bufferedAbort

    const dict = speechSettings.ttsPronunciationDictionary
    const prep = (fragment: string): string => {
      let piece = preprocessTextForProvider(fragment, provider)
      if (dict && Object.keys(dict).length > 0) piece = applyPronunciationDictionary(piece, dict)
      return piece
    }
    const noProgress = () => {}

    // Resolves when consumption must stop early: a fragment failed, or stop()
    // aborted the request. Raced against every token pull.
    const outcome: { failed: boolean; error?: unknown } = { failed: false }
    let halt: () => void = () => {}
    const halted = new Promise<null>((resolve) => {
      halt = () => resolve(null)
    })
    bufferedAbort.signal.addEventListener("abort", halt, { once: true })

    const playPiece = async (
      piece: string,
      gates: { cloud: boolean; remoteVoice: boolean }
    ): Promise<void> => {
      if (outcome.failed || !this.isCurrentRequest(requestId)) return
      if (provider === "system") {
        await this.playSystemChunk(piece, speechSettings, requestId, noProgress, gates.remoteVoice)
        return
      }
      const resp = !gates.cloud
        ? ttsFailure("pii-blocked")
        : await this.generateChunkAudio({
            provider,
            chunk: piece,
            speechSettings,
            providerSettings,
            signal: bufferedAbort.signal,
            requestId,
          })
      // A stop during synthesis or the cache write leaves nothing to play.
      if (!this.isCurrentRequest(requestId)) return
      if (!resp.success || !resp.audioData) {
        if (speechSettings.ttsFallbackEnabled) {
          await this.playSystemChunk(
            piece,
            speechSettings,
            requestId,
            noProgress,
            gates.remoteVoice
          )
          return
        }
        throw new Error(resp.providerMessage || resp.error || "Failed to generate speech audio")
      }
      await this.playAudioResponse(resp, provider, requestId, speechSettings.ttsVolume, noProgress)
    }

    // Fragments are chained so they always play in order. Synthesis happens
    // inside each chain link (sequential) — the first-audio win comes from
    // fragment 1 starting before the reply is finished, not from overlapping
    // synth. The chain never rejects: a failure is recorded and halts the loop.
    let playChain: Promise<void> = Promise.resolve()
    let previousRaw = ""
    const enqueue = (raw: string) => {
      // The pair catches an item the splitter could only cut across whitespace.
      const pair = previousRaw ? `${previousRaw} ${raw}` : raw
      const gates = {
        cloud: allowsOutboundText(provider, raw) && allowsOutboundText(provider, pair),
        remoteVoice: allowsRemoteSystemVoiceText(raw) && allowsRemoteSystemVoiceText(pair),
      }
      previousRaw = raw
      for (const piece of splitTextForTTS(prep(raw), provider)) {
        if (!piece.trim()) continue
        playChain = playChain
          .then(() => playPiece(piece, gates))
          .catch((error: unknown) => {
            if (outcome.failed) return
            outcome.failed = true
            outcome.error = error
            halt()
          })
      }
    }

    const iterator = tokens[Symbol.asyncIterator]()
    let sourceDone = false
    try {
      options.onStart?.()
      const splitter = new SentenceStreamSplitter(options.splitterOptions)
      for (;;) {
        const next = iterator.next()
        // Observed by the race below, or abandoned when consumption halts.
        next.catch(() => undefined)
        const step = await Promise.race([next, halted])
        if (step === null) break
        if (step.done) {
          sourceDone = true
          break
        }
        for (const fragment of splitter.push(step.value)) enqueue(fragment)
      }
      if (!outcome.failed && this.isCurrentRequest(requestId)) {
        const tail = splitter.flush()
        if (tail) enqueue(tail)
        await playChain
      }
      if (outcome.failed) throw outcome.error
      if (!this.isCurrentRequest(requestId)) return

      this.setState({
        playbackState: "stopped",
        isLoading: false,
        isPlaying: false,
        isPaused: false,
        progress: 1,
        activeRequestId: undefined,
        activeSource: undefined,
        activeSourceId: undefined,
      })
      options.onEnd?.()
    } catch (error) {
      if (!this.isCurrentRequest(requestId)) return
      this.failRequest(error, options)
      throw error
    } finally {
      bufferedAbort.signal.removeEventListener("abort", halt)
      // Release a source we stopped reading early, so its producer can stop too.
      if (!sourceDone) void Promise.resolve(iterator.return?.()).catch(() => undefined)
      if (this.bufferedAbort === bufferedAbort) this.bufferedAbort = null
      if (this.isCurrentRequest(requestId)) {
        this.activeRequestId = null
      }
    }
  }

  stop(): void {
    this.activeRequestId = null
    this.systemSpeaking = false
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel()
    }
    // Settle the playback waiter so the stopped `speak()` returns instead of
    // waiting forever for an `ended` event a paused, detached element never fires.
    const finishAudio = this.finishAudio
    this.finishAudio = null
    this.cleanupAudio()
    finishAudio?.()
    if (this.bufferedAbort) {
      this.bufferedAbort.abort()
      this.bufferedAbort = null
    }
    this.setState({
      playbackState: "stopped",
      isLoading: false,
      isPlaying: false,
      isPaused: false,
      progress: 0,
      activeRequestId: undefined,
      activeSource: undefined,
      activeSourceId: undefined,
    })
  }

  pause(): void {
    if (this.state.playbackState !== "playing") return
    // Pause whatever is producing sound now — after a cloud → system fallback
    // the request's provider is cloud but the system voice is speaking.
    if (this.audioRef) {
      this.audioRef.pause()
    } else if (
      this.systemSpeaking &&
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.pause()
    }
    this.setState({
      playbackState: "paused",
      isPlaying: false,
      isPaused: true,
      isLoading: false,
    })
  }

  resume(): void {
    if (this.state.playbackState !== "paused") return
    if (this.audioRef) {
      void this.audioRef.play().catch(() => {})
    } else if (
      this.systemSpeaking &&
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.resume()
    }
    this.setState({
      playbackState: "playing",
      isPlaying: true,
      isPaused: false,
      isLoading: false,
    })
  }

  private failRequest(error: unknown, options: TTSOrchestratorSpeakOptions): void {
    const message = error instanceof Error ? error.message : "Failed to generate speech"
    this.setState({
      playbackState: "error",
      isLoading: false,
      isPlaying: false,
      isPaused: false,
      error: message,
      activeRequestId: undefined,
      activeSource: undefined,
      activeSourceId: undefined,
    })
    options.onError?.(message)
    getTtsHost().notify?.error(message)
  }

  private async generateChunkAudio(params: {
    provider: TTSProvider
    chunk: string
    speechSettings: SpeechSettings
    providerSettings: ProviderSettingsMap
    signal: AbortSignal
    requestId: string
    onGenerated?: () => void
  }): Promise<TTSResponse> {
    const { provider, chunk, speechSettings, providerSettings, signal, requestId } = params
    const apiKey = this.getApiKey(provider, providerSettings)
    const ttsSettings = toTTSSettings(speechSettings)
    const runtimeOptions = getProviderRuntimeOptions(speechSettings, provider)
    if (
      !allowsOutboundText(provider, chunk) ||
      !allowsOutboundText(provider, JSON.stringify(runtimeOptions))
    )
      return ttsFailure("pii-blocked")

    const cacheKey = await generateCacheKey(chunk, provider, ttsSettings)
    return getCachedTtsResponseOrGenerate(
      cacheKey,
      async () => {
        // Retry transient network/api failures before giving up on this chunk.
        const generated = await withTtsRetry(
          () => this.generateUncached(provider, chunk, runtimeOptions, apiKey, signal, requestId),
          { signal }
        )
        if (generated.success) {
          // Metered here — at generation, once per synthesis the provider ran —
          // rather than after playback: a cache hit never reaches this point, an
          // interrupted read was still generated, and the provider is the one
          // that served this chunk.
          params.onGenerated?.()
          getTtsHost().recordSynthesis?.({ provider, characters: chunk.length, requestId })
        }
        return generated
      },
      provider,
      chunk,
      speechSettings.ttsCacheEnabled,
      signal
    )
  }

  private async generateUncached(
    provider: TTSProvider,
    text: string,
    runtimeOptions: Record<string, unknown>,
    apiKey: string,
    signal: AbortSignal,
    requestId: string
  ): Promise<TTSResponse> {
    const info = TTS_PROVIDERS[provider]
    if (apiKey === "host-key" && !getTtsHost().isNativeShell?.())
      return ttsFailure("not-supported", {
        providerMessage: "Native TTS credential bridge is unavailable",
      })
    if (info.requiresApiKey && !apiKey) {
      return {
        success: false,
        error: `Configure an API key for ${info.name} in Settings → Speech.`,
      }
    }
    return this.directGenerate(provider, text, runtimeOptions, apiKey, signal, requestId)
  }

  private async directGenerate(
    provider: TTSProvider,
    text: string,
    options: Record<string, unknown>,
    apiKey: string,
    signal: AbortSignal,
    requestId: string
  ): Promise<TTSResponse> {
    const adapter = getAdapter(provider)
    if (!adapter.generate) {
      return { success: false, error: `Provider ${provider} not supported` }
    }
    if (!allowsOutboundText(provider, text)) {
      return ttsFailure("pii-blocked")
    }
    try {
      return await adapter.generate(text, { ...options, apiKey, signal, requestId })
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Direct generation failed",
      }
    }
  }

  private playAudioResponse(
    response: TTSResponse,
    provider: TTSProvider,
    requestId: string,
    volume: number,
    onProgress: (progress: number) => void
  ): Promise<void> {
    // Audio that arrives for a stopped or superseded request is never played.
    if (!this.isCurrentRequest(requestId)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (!response.success || !response.audioData) {
        reject(new Error(response.error || "Audio generation failed"))
        return
      }
      const blob =
        response.audioData instanceof Blob
          ? response.audioData
          : new Blob([response.audioData], {
              type: response.mimeType || "audio/mpeg",
            })
      this.audioUrlRef = URL.createObjectURL(blob)
      const audio = new Audio(this.audioUrlRef)
      this.audioRef = audio

      let settled = false
      const settle = (error?: unknown) => {
        if (settled) return
        settled = true
        if (this.finishAudio === finish) this.finishAudio = null
        if (this.audioRef === audio) this.cleanupAudio()
        if (error === undefined) resolve()
        else reject(error)
      }
      // `stop()` resolves rather than rejects: a cancelled read is not an error.
      const finish = () => settle()
      this.finishAudio = finish

      audio.onplay = () => {
        if (!this.isCurrentRequest(requestId)) return
        this.setState({
          playbackState: "playing",
          isLoading: false,
          isPlaying: true,
          isPaused: false,
          currentProvider: provider,
        })
      }
      audio.onended = () => settle()
      audio.onerror = () => settle(new Error("Audio playback error"))
      audio.onpause = () => {
        if (
          this.audioRef === audio &&
          audio.currentTime < audio.duration &&
          this.isCurrentRequest(requestId)
        ) {
          this.setState({
            playbackState: "paused",
            isPlaying: false,
            isPaused: true,
          })
        }
      }
      audio.ontimeupdate = () => {
        if (!audio.duration || !this.isCurrentRequest(requestId)) return
        onProgress(audio.currentTime / audio.duration)
      }
      audio.volume = Math.max(0, Math.min(1, volume))
      audio.play().catch((error) => settle(error))
    })
  }

  /**
   * Speak one chunk with the system voice. `remoteVoiceAllowed` is the gate's
   * answer for the text as the caller wrote it; the chunk here is already
   * normalized (`@` → " at "), so it is screened again but cannot vouch for
   * itself.
   */
  private playSystemChunk(
    text: string,
    speechSettings: SpeechSettings,
    requestId: string,
    onProgress: (progress: number) => void,
    remoteVoiceAllowed: boolean
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        reject(new Error("System TTS is not supported"))
        return
      }
      if (!this.isCurrentRequest(requestId)) {
        resolve()
        return
      }
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      // Language of the *spoken* text, not `sttLanguage` (the microphone
      // recognition language). Using sttLanguage here meant a Chinese reply was
      // read by an English voice whenever STT was left on its en-US default.
      utterance.lang = detectLanguage(text)
      const voices = window.speechSynthesis.getVoices()
      const selected = speechSettings.systemVoice
        ? voices.find(
            (v) =>
              v.name === speechSettings.systemVoice || v.voiceURI === speechSettings.systemVoice
          )
        : undefined
      if (selected) utterance.voice = selected

      // A platform voice can be a network service (`localService === false`),
      // so text that may not leave the device is kept on an on-device voice.
      // Without an explicit choice the engine picks the voice, possibly a
      // remote one, so one is pinned.
      const mayLeaveDevice = remoteVoiceAllowed && allowsRemoteSystemVoiceText(text)
      if ((!selected || selected.localService === false) && !mayLeaveDevice) {
        const local = pickLocalVoice(voices, utterance.lang)
        if (!local) {
          reject(new Error(PII_BLOCKED_MESSAGE))
          return
        }
        utterance.voice = local
      }
      utterance.rate = speechSettings.ttsRate
      utterance.pitch = speechSettings.ttsPitch
      utterance.volume = speechSettings.ttsVolume

      const done = () => {
        if (this.isCurrentRequest(requestId)) this.systemSpeaking = false
      }
      utterance.onstart = () => {
        if (!this.isCurrentRequest(requestId)) return
        this.setState({
          playbackState: "playing",
          isLoading: false,
          isPlaying: true,
          isPaused: false,
          currentProvider: "system",
        })
      }
      utterance.onboundary = () => {
        if (!this.isCurrentRequest(requestId)) return
        onProgress(Math.min(0.98, this.state.progress + 0.01))
      }
      utterance.onend = () => {
        done()
        onProgress(1)
        resolve()
      }
      utterance.onerror = (event) => {
        done()
        if (event.error === "canceled" || event.error === "interrupted") {
          resolve()
          return
        }
        reject(new Error(`Speech synthesis error: ${event.error}`))
      }
      this.systemSpeaking = true
      window.speechSynthesis.speak(utterance)
    })
  }

  private getApiKey(provider: TTSProvider, providerSettings: ProviderSettingsMap): string {
    const info = TTS_PROVIDERS[provider]
    if (!info.requiresApiKey && !info.supportsOptionalApiKey) return ""
    const keyProvider = info.apiKeyProvider ?? provider
    return providerSettings?.[keyProvider]?.apiKey ?? ""
  }

  private cleanupAudio(): void {
    if (this.audioRef) {
      this.audioRef.pause()
      this.audioRef = null
    }
    if (this.audioUrlRef) {
      URL.revokeObjectURL(this.audioUrlRef)
      this.audioUrlRef = null
    }
  }

  private updateProgress(progress: number, onProgress?: (progress: number) => void): void {
    const normalized = Math.max(0, Math.min(1, progress))
    this.setState({ progress: normalized })
    onProgress?.(normalized)
  }

  private setState(partialState: Partial<TTSOrchestratorState>): void {
    this.state = { ...this.state, ...partialState }
    for (const sub of this.subscribers) sub(this.state)
  }

  private isCurrentRequest(id: string): boolean {
    return this.activeRequestId === id
  }

  private createRequestId(): string {
    return `tts_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * An on-device voice for `lang`: the platform default when it is local, else
 * a local voice of the same language (full tag, then primary subtag), else
 * any local voice. `null` when the platform lists none.
 */
function pickLocalVoice(
  voices: readonly SpeechSynthesisVoice[],
  lang: string
): SpeechSynthesisVoice | null {
  const local = voices.filter((voice) => voice.localService)
  const primary = lang.split("-")[0]?.toLowerCase()
  const sameLang = (voice: SpeechSynthesisVoice) => voice.lang?.toLowerCase() === lang.toLowerCase()
  const samePrimary = (voice: SpeechSynthesisVoice) =>
    voice.lang?.toLowerCase().split(/[-_]/)[0] === primary
  return (
    local.find((voice) => voice.default && samePrimary(voice)) ??
    local.find(sameLang) ??
    local.find(samePrimary) ??
    local.find((voice) => voice.default) ??
    local[0] ??
    null
  )
}

export const ttsOrchestrator = new TTSOrchestrator()
