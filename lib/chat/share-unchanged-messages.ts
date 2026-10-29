/**
 * Keep the identity of every message that did not change across a re-read.
 *
 * Opening a conversation reads its history from Dexie even when the store
 * already holds it (to catch writes made elsewhere: another device, a
 * background turn), and that read builds a brand-new object for every row.
 * `MessageRenderer` is memoized on message identity, so publishing the read
 * as-is re-rendered every mounted row right after the switch animation — for a
 * transcript that, nine times out of ten, had not changed at all. The same
 * happens when a tail-first preview hands over to the full history: the tail
 * rows on screen are the same rows, freshly cloned.
 *
 * {@link shareUnchangedMessages} returns `next` with every message that is
 * structurally equal to its counterpart in `previous` (by id) replaced by that
 * counterpart, and returns `previous` itself when nothing changed at all, so
 * the store write can be skipped.
 *
 * The comparison is structural over the JSON-like shapes messages are made of,
 * plus `Date` and typed arrays, which a plain key walk would call equal
 * whatever they hold. `lib/settings/changed-settings.ts:valuesEqual` is the
 * same walk without those two cases, which is why it is not reused here.
 */

import type { UIMessage } from "ai"

export function shareUnchangedMessages(
  previous: readonly UIMessage[] | undefined,
  next: UIMessage[]
): UIMessage[] {
  if (!previous || previous.length === 0) return next
  const byId = new Map<string, UIMessage>()
  for (const message of previous) byId.set(message.id, message)
  let changed = previous.length !== next.length
  const shared = next.map((message, index) => {
    const prior = byId.get(message.id)
    const kept = prior !== undefined && structurallyEqual(prior, message) ? prior : message
    if (previous[index] !== kept) changed = true
    return kept
  })
  return changed ? shared : (previous as UIMessage[])
}

/** Deep equality for message payloads. Exported for tests. */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b)

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false
    if (a.byteLength !== b.byteLength || a.constructor !== b.constructor) return false
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
    return true
  }
  const aArray = Array.isArray(a)
  if (aArray !== Array.isArray(b)) return false
  if (aArray) {
    const right = b as unknown[]
    if (a.length !== right.length) return false
    for (let i = 0; i < a.length; i++) if (!structurallyEqual(a[i], right[i])) return false
    return true
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(right, key) || !structurallyEqual(left[key], right[key])) return false
  }
  return true
}
