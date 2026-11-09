/**
 * Pure same-column reorder shared by the boards that persist an `order`.
 *
 * Moves `id` to `targetIndex` within `column` (the column's rows in current
 * visual order) and renumbers `order` 0..n-1. Returns only the rows whose
 * `order` actually changed, ready for a store or database write. An unknown
 * id is a no-op and an out-of-range index is clamped.
 */
export function renumberColumn(
  column: ReadonlyArray<{ id: string; order: number }>,
  id: string,
  targetIndex: number
): Array<{ id: string; order: number }> {
  const fromIndex = column.findIndex((row) => row.id === id)
  if (fromIndex === -1) return []
  const clamped = Math.max(0, Math.min(targetIndex, column.length - 1))
  if (clamped === fromIndex && column.every((row, index) => row.order === index)) return []

  const ids = column.map((row) => row.id)
  ids.splice(fromIndex, 1)
  ids.splice(clamped, 0, id)

  const orderById = new Map(column.map((row) => [row.id, row.order]))
  const changes: Array<{ id: string; order: number }> = []
  ids.forEach((rowId, index) => {
    if (orderById.get(rowId) !== index) changes.push({ id: rowId, order: index })
  })
  return changes
}
