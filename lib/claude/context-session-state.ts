/**
 * What a module's context contributions left for its own tools, per
 * conversation (ADR-0250 §14 `context` amendment).
 *
 * A context contribution may hand back a `sessionState` with its section: the
 * access scope it resolved for this run, which the module's tools need at call
 * time and could not rebuild from the call alone. The send resolver replaces a
 * conversation's whole entry on every resolution; a tool call reads it through
 * `ToolCallContext.sessionState`, scoped to its own module.
 *
 * Bounded to the most recently resolved conversations, so a long-lived host
 * does not keep state for every conversation it ever ran.
 */

/** How many conversations' state is kept; the least recently resolved goes first. */
export const CONTEXT_SESSION_STATE_LIMIT = 64

const states = new Map<string, ReadonlyMap<string, unknown>>()

/**
 * Replace everything the contributions left for `sessionId` with `entries`,
 * keyed `<module>.<id>`. An empty map clears the conversation's entry.
 */
export function replaceContextSessionState(
  sessionId: string,
  entries: ReadonlyMap<string, unknown>
): void {
  states.delete(sessionId)
  if (entries.size === 0) return
  states.set(sessionId, new Map(entries))
  while (states.size > CONTEXT_SESSION_STATE_LIMIT) {
    const oldest = states.keys().next().value
    if (oldest === undefined) break
    states.delete(oldest)
  }
}

/** The state `<module>.<id>` left for `sessionId` at its last resolution, if any. */
export function readContextSessionState(sessionId: string, key: string): unknown {
  return states.get(sessionId)?.get(key)
}

/** Test helper: forget every conversation's state. */
export function __resetContextSessionStateForTests(): void {
  states.clear()
}
