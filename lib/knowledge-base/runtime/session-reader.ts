/**
 * Captured host execution authority; never reconstructed from model/plugin arguments.
 *
 * What a conversation may read from its agent's knowledge bases, and the
 * progressive reader over them, as its last send resolution left them. The
 * knowledge-base module's `reader` context contribution (`../context.ts`)
 * hands the state back with its section; the kernel keeps it per conversation
 * (`lib/claude/context-session-state.ts`). This file reads it for the module's
 * tools, nested dispatch and the plugin project API, and lets tests and
 * fixtures place one directly.
 *
 * A capture unused for an hour reads as absent, so every reader fails closed.
 */
import {
  readContextSessionState,
  replaceContextSessionState,
} from "@/lib/claude/context-session-state"
import {
  createKnowledgeReader,
  type KnowledgeReader,
  type KnowledgeReaderInput,
  type KnowledgeReadingAccess,
} from "./progressive-reading"

/** Where the kernel keeps this module's state: the `reader` contribution's key. */
export const KNOWLEDGE_SESSION_STATE_KEY = "knowledge-base.reader"
const MAX_IDLE_MS = 60 * 60 * 1_000

/** What the `reader` contribution leaves for a conversation. */
export interface KnowledgeSessionState {
  knowledgeBaseIds: readonly string[]
  knowledgeAccess: KnowledgeReadingAccess
  /** Present only while progressive reading is on and the agent has bound bases. */
  reader?: KnowledgeReader
  /** The last time anything read this capture. */
  lastUsedAt: number
}

/** A capture of the authority, with defensive copies of everything a caller passed. */
export function captureKnowledgeSessionState(input: {
  knowledgeBaseIds: readonly string[]
  knowledgeAccess?: KnowledgeReadingAccess
  reader?: KnowledgeReader
}): KnowledgeSessionState {
  return {
    knowledgeBaseIds: [...input.knowledgeBaseIds],
    knowledgeAccess: structuredClone(input.knowledgeAccess ?? {}),
    ...(input.reader ? { reader: input.reader } : {}),
    lastUsedAt: Date.now(),
  }
}

/**
 * The capture the `reader` contribution left, while it is fresh; reading it
 * counts as use. The module's tools pass `ToolCallContext.sessionState("reader")`.
 */
export function liveKnowledgeSessionState(state: unknown): KnowledgeSessionState | undefined {
  const capture = state as KnowledgeSessionState | undefined
  if (!capture || typeof capture.lastUsedAt !== "number") return undefined
  const now = Date.now()
  if (now - capture.lastUsedAt > MAX_IDLE_MS) return undefined
  capture.lastUsedAt = now
  return capture
}

function liveState(sessionId: string): KnowledgeSessionState | undefined {
  return liveKnowledgeSessionState(readContextSessionState(sessionId, KNOWLEDGE_SESSION_STATE_KEY))
}

/** Defensive copies let nested dispatch narrow a ceiling without mutating its parent. */
export function getKnowledgeAccessForSession(
  sessionId: string
): { knowledgeBaseIds: readonly string[]; knowledgeAccess: KnowledgeReadingAccess } | undefined {
  const state = liveState(sessionId)
  if (!state) return undefined
  return {
    knowledgeBaseIds: [...state.knowledgeBaseIds],
    knowledgeAccess: structuredClone(state.knowledgeAccess),
  }
}

export function getKnowledgeReaderForSession(sessionId: string): KnowledgeReader | undefined {
  return liveState(sessionId)?.reader
}

/**
 * Tests and fixtures: place an authority for a conversation without a send
 * resolution. Replaces everything the contributions left for it.
 */
export function registerKnowledgeAccessForSession(
  sessionId: string,
  input: { knowledgeBaseIds: readonly string[]; knowledgeAccess?: KnowledgeReadingAccess }
): void {
  if (!sessionId.trim()) throw new Error("session_required")
  replaceContextSessionState(
    sessionId,
    new Map([[KNOWLEDGE_SESSION_STATE_KEY, captureKnowledgeSessionState(input)]])
  )
}

/** Tests and fixtures: place an authority and a reader built from `input`. */
export function registerKnowledgeReaderForSession(
  sessionId: string,
  input: KnowledgeReaderInput
): void {
  if (!sessionId.trim()) throw new Error("session_required")
  replaceContextSessionState(
    sessionId,
    new Map([
      [
        KNOWLEDGE_SESSION_STATE_KEY,
        captureKnowledgeSessionState({
          knowledgeBaseIds: input.knowledgeBaseIds,
          knowledgeAccess: {
            entrypoint: input.entrypoint,
            triggeredBy: input.triggeredBy,
            revisionBindings: input.revisionBindings,
            allowedKnowledgeBaseIds: input.allowedKnowledgeBaseIds,
          },
          reader: createKnowledgeReader(input),
        }),
      ],
    ])
  )
}

/** Tests and fixtures: forget what was placed for a conversation. */
export function clearKnowledgeReaderForSession(sessionId: string): void {
  replaceContextSessionState(sessionId, new Map())
}
