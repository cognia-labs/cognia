/**
 * Remembered open/closed choices for the transcript's disclosures — the
 * "Worked for …" fold, a tool group, a single tool row.
 *
 * Every one of those used to keep its state in `useState`, which dies with the
 * component. In the transcript, components die all the time without the reader
 * doing anything: the virtualizer unmounts a row the moment it scrolls out of
 * its window, a turn that seals moves its tool rows under the fold (a new
 * parent, so a remount), and a single tool call becomes a group the moment a
 * second one streams in. Each of those silently closed whatever the reader had
 * opened, and scrolling back up found it shut again.
 *
 * So the choice lives here, keyed by what it is about (session, message, tool
 * call) rather than by where it happens to be mounted. Only explicit choices
 * are stored: a disclosure nobody touched keeps following its live default
 * (a running call open, a settled one closed), and a stored choice always wins
 * over that default.
 *
 * Process memory only, on purpose. A fold left open last week is not something
 * a reader expects to find open after a restart, and nothing here is worth a
 * Dexie write per click. Bounded as an LRU so a long-lived window cannot grow
 * it without limit.
 */

/** Oldest choices are forgotten past this many. */
export const DISCLOSURE_MEMORY_LIMIT = 4000

const entries = new Map<string, boolean>()
const listeners = new Map<string, Set<() => void>>()

/**
 * The memory key for a disclosure. `scope` is normally the session id; the
 * remaining segments identify the thing (message id, tool call id, kind).
 */
export function disclosureKey(
  scope: string | null | undefined,
  ...segments: ReadonlyArray<string | number>
): string {
  return [scope ?? "-", ...segments].join(":")
}

/** The reader's explicit choice for `key`, or undefined when they never made one. */
export function readDisclosure(key: string): boolean | undefined {
  return entries.get(key)
}

/** Record an explicit choice. Re-writing a key refreshes its LRU position. */
export function writeDisclosure(key: string, open: boolean): void {
  const previous = entries.get(key)
  entries.delete(key)
  entries.set(key, open)
  while (entries.size > DISCLOSURE_MEMORY_LIMIT) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
    // An evicted key's subscribers read "no choice" from now on.
    notify(oldest)
  }
  if (previous !== open) notify(key)
}

/** Record the same choice for several keys at once (a group's "expand all"). */
export function writeDisclosures(keys: readonly string[], open: boolean): void {
  for (const key of keys) writeDisclosure(key, open)
}

/** Listen for changes to one key. Returns the unsubscribe. */
export function subscribeDisclosure(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(key)
  }
}

/** Forget every choice. For tests, and for a full account / scope reset. */
export function resetDisclosureMemory(): void {
  const keys = [...entries.keys()]
  entries.clear()
  for (const key of keys) notify(key)
}

function notify(key: string): void {
  const set = listeners.get(key)
  if (!set) return
  for (const listener of [...set]) listener()
}
