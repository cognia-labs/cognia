/**
 * Shared drag-and-drop rules for the Squad and single-Agent task boards.
 *
 * `components/board/kanban-board.tsx` hands its consumer the raw dnd-kit ids
 * of the card being dragged and of what it was released over. This module
 * turns that pair into what the drop MEANS — a guarded move to another
 * column, a reorder within its own column, a denial, or nothing — and works
 * out where an insertion indicator belongs while the drag is in flight.
 *
 * Every domain decision arrives as a rule: what an item's status is, which
 * items share its column (a Squad board narrows the column to one team), and
 * whether a move or a reorder is allowed. So the same reducer serves the
 * Squad and agent-task boards without knowing any of them, and the
 * affordances it drives (the drop itself, the indicator) read the same guard
 * that greys a column out.
 */

import type { MoveVerdict } from "./move-guard"

/** Droppable ids of columns carry this prefix; anything else is a card id. */
const COLUMN_PREFIX = "col:"

/** dnd-kit droppable id of a column. */
export const columnDropId = (status: string): string => `${COLUMN_PREFIX}${status}`

export type BoardDndTarget<S extends string> =
  { kind: "column"; status: S } | { kind: "card"; itemId: string }

/** Parse a droppable or sortable id back into what it names. */
export function parseBoardDndId<S extends string>(id: string): BoardDndTarget<S> {
  if (id.startsWith(COLUMN_PREFIX)) {
    return { kind: "column", status: id.slice(COLUMN_PREFIX.length) as S }
  }
  return { kind: "card", itemId: id }
}

export type BoardDropAction<S extends string, R extends string> =
  | { type: "move"; itemId: string; to: S; targetIndex: number }
  | { type: "reorder"; itemId: string; targetIndex: number }
  | { type: "denied"; itemId: string; reason: R }

export interface BoardDropRules<S extends string, T, R extends string> {
  /** Every item on the board, keyed by its dnd-kit id. */
  itemsById: ReadonlyMap<string, T>
  /** The item's dnd-kit id (its key in `itemsById`). */
  idOf: (item: T) => string
  statusOf: (item: T) => S
  /**
   * The items of the column `status` that `item` shares a board with, in
   * visual order. May include `item` itself.
   */
  columnOf: (item: T, status: S) => readonly T[]
  /** Whether `item` may be reordered within its own column. Absent means always. */
  canReorder?: (item: T) => MoveVerdict<R>
  /** Whether `item` may move between two different columns. */
  canMove: (item: T, from: S, to: S) => MoveVerdict<R>
}

interface ResolvedTarget<S extends string, T> {
  item: T
  over: BoardDndTarget<S>
  targetStatus: S
}

function resolveTarget<S extends string, T, R extends string>(
  activeId: string | null,
  overId: string | null,
  rules: BoardDropRules<S, T, R>
): ResolvedTarget<S, T> | null {
  if (!activeId || !overId) return null
  const active = parseBoardDndId<S>(activeId)
  if (active.kind !== "card") return null
  const item = rules.itemsById.get(active.itemId)
  if (!item) return null

  const over = parseBoardDndId<S>(overId)
  let targetStatus: S | null
  if (over.kind === "column") {
    targetStatus = over.status
  } else {
    const overItem = rules.itemsById.get(over.itemId)
    targetStatus = overItem ? rules.statusOf(overItem) : null
  }
  if (targetStatus === null) return null
  return { item, over, targetStatus }
}

/**
 * Resolve a drag-end into a board action, or null for a no-op. Dropping on a
 * card in the same column reorders to that card's index; dropping on another
 * column, or on a card inside it, is a guarded move; dropping back on the
 * card's own column is nothing.
 */
export function resolveBoardDrop<S extends string, T, R extends string>(
  activeId: string | null,
  overId: string | null,
  rules: BoardDropRules<S, T, R>
): BoardDropAction<S, R> | null {
  if (activeId === overId) return null
  const target = resolveTarget(activeId, overId, rules)
  if (!target) return null
  const { item, over, targetStatus } = target
  const itemId = rules.idOf(item)
  const from = rules.statusOf(item)

  if (targetStatus === from) {
    if (over.kind === "column") return null
    const reorder = rules.canReorder?.(item)
    if (reorder && !reorder.allowed) return { type: "denied", itemId, reason: reorder.reason }
    const targetIndex = rules
      .columnOf(item, from)
      .findIndex((candidate) => rules.idOf(candidate) === over.itemId)
    if (targetIndex === -1) return null
    return { type: "reorder", itemId, targetIndex }
  }

  const verdict = rules.canMove(item, from, targetStatus)
  if (!verdict.allowed) return { type: "denied", itemId, reason: verdict.reason }
  const preview = resolveBoardDropPreview(activeId, overId, rules)
  if (!preview) return null
  return { type: "move", itemId, to: targetStatus, targetIndex: preview.index }
}

/** Where the dragged card would land right now. */
export interface BoardDropPreview<S extends string> {
  status: S
  /** Insertion index within the target column without the dragged card. */
  index: number
}

/**
 * The insertion point for the drag in flight, or null when the target would
 * refuse the card, so no indicator is drawn on a column the guard greys out.
 * The index counts the target column WITHOUT the dragged card, because that
 * is the sequence the card is being inserted into.
 */
export function resolveBoardDropPreview<S extends string, T, R extends string>(
  activeId: string | null,
  overId: string | null,
  rules: BoardDropRules<S, T, R>
): BoardDropPreview<S> | null {
  const target = resolveTarget(activeId, overId, rules)
  if (!target) return null
  const { item, over, targetStatus } = target
  const itemId = rules.idOf(item)
  const from = rules.statusOf(item)

  const verdict =
    targetStatus === from
      ? (rules.canReorder?.(item) ?? { allowed: true })
      : rules.canMove(item, from, targetStatus)
  if (!verdict.allowed) return null

  const column = rules
    .columnOf(item, targetStatus)
    .filter((candidate) => rules.idOf(candidate) !== itemId)
  if (over.kind === "column") return { status: targetStatus, index: column.length }
  const index = column.findIndex((candidate) => rules.idOf(candidate) === over.itemId)
  return { status: targetStatus, index: index === -1 ? column.length : index }
}
