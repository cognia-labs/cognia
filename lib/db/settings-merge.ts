/**
 * Three-way merge of the settings singleton for a save that raced another
 * writer.
 *
 * `saveSettings` reads the row, resolves its credentials (keyring or IPC, so
 * not inside an IndexedDB transaction), merges the patch and writes the whole
 * row back. Anything that wrote the row in between, the account sync applier
 * taking another device's theme or a paired Host pull, used to be overwritten
 * with the stale values the save had read, and capture then sent those stale
 * values back out as new local edits. The write now re-reads the row inside
 * its transaction and keeps, key by key, whichever side actually changed it.
 */

/**
 * Structural equality over values read from IndexedDB (structured clones of
 * JSON-shaped settings). `undefined` and a missing key are the same; `null`
 * is a value of its own.
 */
export function sameSettingsValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameSettingsValue(item, b[index]))
    )
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if (!sameSettingsValue(left[key], right[key])) return false
  return true
}

export interface ConcurrentSettingsMerge<Row extends object> {
  /** The row as this save read it (`undefined`: there was none). */
  base: Row | undefined
  /** The row this save computed from `base` and its patch. */
  ours: Row
  /** The row as it is now, read inside the write's transaction. */
  theirs: Row | undefined
  /** Keys the caller asked to change: on a conflict, theirs yields to these. */
  explicit: ReadonlySet<string>
  /** Keys always taken from `ours` (the row id, this save's credential pointer). */
  oursOnly: ReadonlySet<string>
}

/**
 * Per key: a side that left it as `base` had it yields to the side that
 * changed it. When both changed it, an explicit edit of this save wins, and a
 * value this save only filled in (a default, a normalization) yields to the
 * concurrent writer's.
 */
export function mergeConcurrentSettingsRow<Row extends object>(
  input: ConcurrentSettingsMerge<Row>
): Row {
  const { explicit, oursOnly } = input
  if (!input.theirs) return input.ours
  const ours = input.ours as Record<string, unknown>
  const theirs = input.theirs as Record<string, unknown>
  const before = (input.base ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(ours), ...Object.keys(theirs)])
  for (const key of keys) {
    let value: unknown
    if (oursOnly.has(key)) {
      value = ours[key]
    } else {
      const oursChanged = !sameSettingsValue(ours[key], before[key])
      const theirsChanged = !sameSettingsValue(theirs[key], before[key])
      if (!theirsChanged) value = ours[key]
      else if (!oursChanged) value = theirs[key]
      else value = explicit.has(key) ? ours[key] : theirs[key]
    }
    if (value !== undefined) out[key] = value
  }
  return out as Row
}
