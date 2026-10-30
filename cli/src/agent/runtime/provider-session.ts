/**
 * A provider session that outlives a single turn.
 *
 * `runUnifiedTurn` builds a provider session, runs one turn (retrying inside
 * it), and closes it. That is exactly right for `cognia-agent run -p`, where
 * the process exits afterwards anyway.
 *
 * It is wrong for anything that holds a conversation. The SDK's `CogniaSession`
 * and the RPC server's per-session state both need the SAME provider session
 * across many turns — not because reopening is slow, but because a reopened
 * session has nothing to talk to: `/compact` needs a live control channel,
 * `enqueue` needs a turn in flight to queue behind, and `setModel` mid-session
 * is meaningless against a session that will be discarded before the next
 * prompt. Re-opening per turn would give all three a plausible API that
 * silently does nothing.
 *
 * So the lifetime becomes the caller's. A lease is handed to `runUnifiedTurn`,
 * which borrows the session instead of owning it, and the caller closes it when
 * the conversation ends.
 */

import type { AgentSession } from "../session-runner"

export interface ProviderSessionLease {
  /**
   * Get the live session, building it on first use.
   *
   * `key` fingerprints what the session was built FOR (backend, session id,
   * model). If it differs from the live session's key, the old session is
   * closed and a new one built — a caller that changes backend mid-conversation
   * gets a real switch, never a stale session silently answering for the
   * backend it replaced.
   */
  session(key: string, build: () => AgentSession): AgentSession
  /** Replace a session built for a different key after awaiting its teardown. */
  replace(key: string, build: () => AgentSession): Promise<AgentSession>
  /**
   * Close the live session, sharing its teardown proof with concurrent callers.
   * A rejected teardown stays latched; after stopping the original executor,
   * the caller must reset the session and create a fresh lease.
   */
  close(): Promise<void>
  /** The key of the live session, or null when none is open. */
  readonly openKey: string | null
  /** The live provider session, for transport-neutral control adapters. */
  readonly current: AgentSession | null
}

export function createProviderSessionLease(): ProviderSessionLease {
  let current: AgentSession | null = null
  let currentKey: string | null = null
  let teardown: Promise<void> | null = null

  const closeCurrent = (): Promise<void> => {
    if (teardown) return teardown
    const session = current
    current = null
    currentKey = null
    if (!session) return Promise.resolve()
    let closing: Promise<void>
    try {
      closing = Promise.resolve(session.close())
    } catch (error) {
      closing = Promise.reject(error)
    }
    teardown = closing
    void closing.then(
      () => {
        if (teardown === closing) teardown = null
      },
      // Keep failed teardown latched: an idempotent close returning early on a
      // second call is not proof that the old executor stopped.
      () => undefined
    )
    return closing
  }

  return {
    session(key, build) {
      if (teardown) throw new Error("provider session teardown must complete before reuse")
      if (current && currentKey === key) return current
      if (current) {
        throw new Error("provider session key changed; use replace() to await teardown")
      }
      const session = build()
      current = session
      currentKey = key
      return session
    },
    async replace(key, build) {
      if (teardown) await teardown
      if (current && currentKey === key) return current
      if (current) await closeCurrent()
      const session = build()
      current = session
      currentKey = key
      return session
    },
    close: closeCurrent,
    get openKey() {
      return currentKey
    },
    get current() {
      return current
    },
  }
}

/**
 * Fingerprint the inputs that make a provider session non-interchangeable.
 *
 * Deliberately NOT everything in the config: per-turn knobs like the approval
 * mode or the tool allow-list are re-applied on each `send`, so folding them in
 * would rebuild the session — and lose its context — every time a caller
 * toggled one.
 */
export function providerSessionKey(input: {
  sessionId: string
  backendId: string
  model?: string
  cwd?: string
}): string {
  return [input.sessionId, input.backendId, input.model ?? "", input.cwd ?? ""].join("\0")
}
