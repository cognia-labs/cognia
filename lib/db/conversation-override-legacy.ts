/**
 * The conversation override's Squad binding was spelled `teamId` /
 * `teamDisabled` until ADR-0252 §6 renamed it `squadId` / `squadDisabled`
 * (a character team now binds a conversation too, and "team" named both).
 *
 * Rows written before the rename, and writes relayed by a client built before
 * it, still carry the old names. Rather than teach every reader both spellings,
 * the table's hooks translate in one place: a read answers with the new names,
 * a create stores them, and any update of an old row moves the binding over in
 * the same write, so a later clear can never be undone by a stale `teamId`
 * reappearing on read. Not a Dexie upgrade: the fields are non-indexed and a
 * row is rewritten only when something writes it anyway.
 */

import type { Table } from "dexie"
import type { ConversationOverrideRow } from "./connector-types"

/** The pre-ADR-0252 spellings this module translates. */
export interface LegacyConversationOverrideRouting {
  teamId?: string
  teamDisabled?: boolean
}

type RoutingFields = {
  squadId?: string
  squadDisabled?: boolean
} & LegacyConversationOverrideRouting

const LEGACY_TO_CURRENT = [
  ["teamId", "squadId"],
  ["teamDisabled", "squadDisabled"],
] as const

function hasLegacyKey(value: object): boolean {
  return LEGACY_TO_CURRENT.some(([legacy]) => legacy in value)
}

/** A copy with the old names folded into the new ones (the new ones win). */
function withCurrentNames<T extends RoutingFields>(value: T): T {
  if (!hasLegacyKey(value)) return value
  const next: RoutingFields = { ...value }
  for (const [legacy, current] of LEGACY_TO_CURRENT) {
    if (!(legacy in next)) continue
    const old = next[legacy]
    delete next[legacy]
    if (next[current] === undefined && old !== undefined) {
      ;(next as Record<string, unknown>)[current] = old
    }
  }
  return next as T
}

/** The row as every reader sees it, whatever names it was stored under. */
export function readConversationOverride(row: ConversationOverrideRow): ConversationOverrideRow {
  // Dexie hands the hook a miss as `undefined` on some read paths.
  if (!row || typeof row !== "object") return row
  const routing = withCurrentNames(row as ConversationOverrideRow & RoutingFields)
  const snapshot = routing.assignmentPreviousRouting as RoutingFields | undefined
  if (!snapshot || !hasLegacyKey(snapshot)) return routing
  return {
    ...routing,
    assignmentPreviousRouting: withCurrentNames(snapshot),
  } as ConversationOverrideRow
}

/** Rename a row about to be created, in place (Dexie's `creating` contract). */
export function renameOnCreate(row: ConversationOverrideRow & RoutingFields): void {
  const current = readConversationOverride(row)
  for (const [legacy] of LEGACY_TO_CURRENT) delete row[legacy]
  Object.assign(row, current)
}

/**
 * Extra modifications for an update (Dexie's `updating` contract): a write
 * that still spells the old names lands under the new ones, and an update of
 * an old row moves its binding over unless the write sets the new name itself.
 * `undefined` values in the result delete the key.
 */
export function renameOnUpdate(
  mods: Record<string, unknown>,
  stored: ConversationOverrideRow & RoutingFields
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {}
  for (const [legacy, current] of LEGACY_TO_CURRENT) {
    if (legacy in mods) {
      if (!(current in mods)) extra[current] = mods[legacy]
      extra[legacy] = undefined
    } else if (legacy in stored) {
      if (!(current in mods) && stored[current] === undefined) extra[current] = stored[legacy]
      extra[legacy] = undefined
    }
  }
  const snapshotKey = "assignmentPreviousRouting"
  const snapshot = (snapshotKey in mods ? mods[snapshotKey] : stored[snapshotKey]) as
    RoutingFields | undefined
  if (snapshot && typeof snapshot === "object" && hasLegacyKey(snapshot)) {
    extra[snapshotKey] = withCurrentNames(snapshot)
  }
  return Object.keys(extra).length > 0 ? extra : undefined
}

/** Install the three hooks on the `conversationOverrides` table. */
export function installConversationOverrideLegacyHooks(
  table: Table<ConversationOverrideRow, string>
): void {
  table.hook("reading", readConversationOverride)
  table.hook("creating", (_key, row) => {
    renameOnCreate(row as ConversationOverrideRow & RoutingFields)
  })
  table.hook("updating", (mods, _key, row) =>
    renameOnUpdate(mods as Record<string, unknown>, row as ConversationOverrideRow & RoutingFields)
  )
}
