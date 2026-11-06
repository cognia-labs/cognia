// The `speech` capability port (ADR-0250 §14, M3's first port): reading text
// aloud, synthesising audio to send, and what the chat needs to know about a
// live voice session. The kernel declares it here; the speech module
// (`lib/speech/module.ts`) provides it. Users ask `lib/modules/ports.ts` for
// `"speech"` and never import `lib/tts/` or `lib/voice/`.
//
// Every method reads the person's speech settings and provider keys itself,
// so a user passes only what it knows: the text, whose voice, and its own id.

import type { TTSOrchestratorState, TTSSynthesisResult } from "@cognia/tts/tts-orchestrator"
import type { Ruleset } from "@cognia/plugin-contract/lib/claude/permissions/ruleset"
import type { CharacterVoiceSource } from "@/lib/plugin/character-pack/character-voice"

/** Whose voice reads: a character's voice profile overlays the person's voice. */
export type SpeechVoice = CharacterVoiceSource | null | undefined

/** The one read-aloud player every surface shares (one utterance at a time). */
export interface SpeechReadAloud {
  /** What is playing now, and for which surface and id. */
  getState(): TTSOrchestratorState
  /** Hear every state change. Returns the unsubscribe function. */
  subscribe(listener: (state: TTSOrchestratorState) => void): () => void
  /** Stop whatever is playing. */
  stop(): void
  /** Read a chat message; `messageId` becomes the active source id. Empty text does nothing. */
  speakChatMessage(args: {
    messageId: string
    text: string
    character?: SpeechVoice
  }): Promise<void>
  /** Read a chat message while it streams, starting before the text is complete. */
  speakChatMessageStream(
    tokens: AsyncIterable<string>,
    args: { messageId: string; character?: SpeechVoice }
  ): Promise<void>
  /** The pet speaks. Text that fails the PII gate is not read. */
  speakPet(text: string, character?: SpeechVoice): Promise<void>
  /** Read a desktop selection; `candidateId` becomes the active source id. */
  speakSelection(args: { candidateId: string; text: string }): Promise<void>
  /** Stop reading the selection, if it is still the one playing. */
  stopSelection(candidateId: string): void
  /**
   * Follow one selection's reading: `playing: true` with its progress while it
   * plays, then `playing: false` once, when it ends or is replaced.
   */
  watchSelection(
    candidateId: string,
    onChange: (update: { playing: boolean; progress?: number }) => void
  ): () => void
}

/** A buffered synthesis, for audio that leaves the device (a connector's voice message). */
export interface SpeechSynthesisRequest {
  text: string
  character?: SpeechVoice
  signal?: AbortSignal
  /** Asked before any text reaches a provider; a refusal fails the synthesis. */
  approveText?: (text: string) => boolean
}

/** What the chat must know about live voice sessions it does not run. */
export interface SpeechLive {
  /** Whether an approval request id belongs to a live voice session's tool call. */
  isToolApprovalRequest(requestId: string): boolean
  /**
   * "Always allow" for a live voice tool: the session stops asking now, and the
   * returned rules allow the tool from then on (the caller saves them).
   */
  allowToolAlways(sessionId: string, toolName: string, rules: Ruleset | undefined): Ruleset
}

export interface SpeechPort {
  readAloud: SpeechReadAloud
  synthesize(request: SpeechSynthesisRequest): Promise<TTSSynthesisResult>
  live: SpeechLive
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    speech: SpeechPort
  }
}
