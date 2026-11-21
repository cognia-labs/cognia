/**
 * The Scheduler's id for one workflow schedule: a trigger node of one
 * workflow. A node id alone is not unique — a copied workflow keeps its node
 * ids — so both halves are part of the id, each escaped so a `:` inside an id
 * cannot shift the split.
 */

export function workflowScheduleSourceId(workflowId: string, triggerId: string): string {
  return `${encodeURIComponent(workflowId)}:${encodeURIComponent(triggerId)}`
}

/** Inverse of {@link workflowScheduleSourceId}; `undefined` for anything else. */
export function parseWorkflowScheduleSourceId(
  sourceId: string
): { workflowId: string; triggerId: string } | undefined {
  const parts = sourceId.split(":")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined
  try {
    return { workflowId: decodeURIComponent(parts[0]), triggerId: decodeURIComponent(parts[1]) }
  } catch {
    return undefined
  }
}
