/**
 * Settings keys merged by property (protocol §7.2, §9; `SETTINGS_MERGED_BY_PROPERTY`).
 *
 * Such a key's value is an object of independent preferences. Each changed
 * property travels in its own field `value.<property>`, and `value` is a write
 * of the whole object. Capture, push and seeding read the key through these
 * helpers; the merge itself is `mergeSettingProperties` in
 * `@cognia/sync-protocol`.
 *
 * A property holding `null` or `undefined` is absent: the protocol uses
 * `[null, hlc]` to remove one.
 */

import {
  SETTINGS_VALUE_FIELD,
  settingsPropertyField,
  settingsPropertyOf,
} from "@cognia/sync-protocol"
import { DEFAULTS } from "@/lib/db/settings"

import { sameValue } from "./stable-json"

/** Whether a settings value is an object whose properties merge one by one. */
export function isSettingObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function present(value: unknown): unknown {
  return value === null ? undefined : value
}

/** The properties a value holds (absent ones left out). */
function propertiesOf(value: unknown): Record<string, unknown> {
  if (!isSettingObject(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, v]) => present(v) !== undefined))
}

export interface SettingPropertyChange {
  /** `value.<property>` for each changed property, or `value` alone for a clear. */
  fields: string[]
  /** The key was cleared: its property clocks give way to the clear's. */
  clears: boolean
}

/** Which fields a write from `previous` to `next` changes, or `null` when none. */
export function settingPropertyChange(
  previous: unknown,
  next: unknown
): SettingPropertyChange | null {
  const before = propertiesOf(previous)
  const after = propertiesOf(next)
  if (Object.keys(after).length === 0) {
    // Nothing left (cleared, or a value with no property): one whole write.
    return Object.keys(before).length > 0 ? { fields: [SETTINGS_VALUE_FIELD], clears: true } : null
  }
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((property) => !sameValue(before[property], after[property]))
    .sort()
    .map(settingsPropertyField)
  return fields.length > 0 ? { fields, clears: false } : null
}

/**
 * The value `value` carries when it is pushed: the properties that have no
 * clock of their own, as of the key's whole-write clock (`null` when there are
 * none, as right after a clear). Sending `null` instead would remove, on a
 * device that has not seen that whole write yet, properties it set.
 */
export function wholeValueToPush(
  value: unknown,
  fieldClocks: Readonly<Record<string, string>>
): Record<string, unknown> | null {
  const entries = Object.entries(propertiesOf(value)).filter(
    ([property]) => fieldClocks[settingsPropertyField(property)] === undefined
  )
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/** The value a `value.<property>` field carries when it is pushed. */
export function propertyValueToPush(value: unknown, field: string): unknown {
  const property = settingsPropertyOf(field)
  if (property === null) return null
  return present(propertiesOf(value)[property]) ?? null
}

/**
 * The properties of a key's value that differ from the app's default for
 * them: what this device holds of its own (protocol §5.4).
 */
export function ownProperties(key: string, value: unknown): string[] {
  const fallback = propertiesOf((DEFAULTS as unknown as Record<string, unknown>)[key])
  return Object.entries(propertiesOf(value))
    .filter(([property, v]) => !sameValue(v, fallback[property]))
    .map(([property]) => property)
    .sort()
}
