/**
 * Session-level Claude Agent SDK functions over the `session_api` frame:
 * list, read, rename, tag, delete, fork and import stored sessions and
 * subagent transcripts, and resolve SDK settings, with no live query. The
 * round trip shares the sidecar client's correlated listener.
 */
import type { SendOptions, SessionApiMethod } from "@cognia/agent-config-types"

import { sidecarRoundTrip } from "@/lib/claude/ipc"

// ---- Session-level SDK functions (the `session_api` frame) ----------------
//
// `sessionControl` in the sidecar client drives a LIVE query by session id. These do the
// opposite: they read and mutate transcripts on disk with no session running,
// which is what makes session management reachable from Settings with no chat
// open. Same correlation machinery, different Tauri command and frame type.

/**
 * A filesystem scan across every project directory can genuinely outrun the
 * 8s control budget on a large machine, and a timeout there reads to the user
 * as a broken feature rather than a slow one.
 */
const SESSION_API_TIMEOUT_MS = 20_000

/**
 * Call an allowlisted session-level SDK function and await its result.
 *
 * `sendOptions` names the SessionStore backend for the call — it is forwarded
 * verbatim to the sidecar, which resolves it to a live store. The renderer
 * never sends a store: the descriptor names a backend, never a location.
 *
 * Rejects with the sidecar's stable error code (`unknown_method`,
 * `invalid_session_id`, `no_session_store`, …) or `sidecar exited`. Callers
 * that can run against a non-Anthropic runtime must gate on
 * `SESSION_API_CAPABILITIES` first — this is IPC, and ADR-0090 constraint 3
 * wants the fail-closed decision made before it.
 */
export type SdkSessionApiOptions = Pick<SendOptions, "cwd" | "execution" | "claudeAgentSdk">

export async function sessionApi<T = unknown>(
  method: SessionApiMethod,
  params?: Record<string, unknown>,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sidecarRoundTrip<T>(
    "agent_session_api",
    (requestId) => ({ requestId, method, params, sendOptions }),
    `session api "${method}"`,
    SESSION_API_TIMEOUT_MS
  )
}

/** Sessions the SDK can see, from the store and/or `dir`'s transcripts. */
export function listSdkSessions<T = unknown>(
  params?: { dir?: string },
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("listSessions", params, sendOptions)
}

/** Metadata for one session (title, tag, timestamps). */
export function getSdkSessionInfo<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("getSessionInfo", { sessionId }, sendOptions)
}

/**
 * One session's message chain.
 *
 * This is the COMPACTED chain — the SDK drops what compaction replaced. A
 * caller that needs the raw history reads the store directly rather than
 * "fixing" a short result by re-fetching here.
 */
export function getSdkSessionMessages<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("getSessionMessages", { sessionId }, sendOptions)
}

/** Subagents that ran inside a session. */
export function listSdkSubagents<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("listSubagents", { sessionId }, sendOptions)
}

/** One subagent's own message chain. */
export function getSdkSubagentMessages<T = unknown>(
  sessionId: string,
  agentId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("getSubagentMessages", { sessionId, agentId }, sendOptions)
}

/** Retitle a session. */
export function renameSdkSession(
  sessionId: string,
  title: string,
  sendOptions?: SdkSessionApiOptions
): Promise<void> {
  return sessionApi<void>("renameSession", { sessionId, title }, sendOptions)
}

/** Set or clear a session's tag. `null` is the documented "clear" value. */
export function tagSdkSession(
  sessionId: string,
  tag: string | null,
  sendOptions?: SdkSessionApiOptions
): Promise<void> {
  return sessionApi<void>("tagSession", { sessionId, tag }, sendOptions)
}

/**
 * Delete a session's transcript.
 *
 * Irreversible, and it cascades to the session's subagent transcripts. Callers
 * owe the user a confirmation — {@link isMutatingSessionApiMethod} is exported
 * from the contract so a UI can decide that from the method rather than from a
 * hand-maintained list of "the scary ones".
 */
export function deleteSdkSession(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<void> {
  return sessionApi<void>("deleteSession", { sessionId }, sendOptions)
}

/** Copy a session so a new branch can diverge from it. */
export function forkSdkSession<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("forkSession", { sessionId }, sendOptions)
}

/**
 * Copy a local JSONL transcript into the configured SessionStore.
 *
 * Requires a store — without one the sidecar rejects with `no_session_store`
 * rather than silently doing nothing.
 */
export function importSdkSessionToStore<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("importSessionToStore", { sessionId }, sendOptions)
}

/** The effective settings layers the SDK would apply (user/project/local). */
export function resolveSdkSettings<T = unknown>(
  params?: { dir?: string },
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("resolveSettings", params, sendOptions)
}
