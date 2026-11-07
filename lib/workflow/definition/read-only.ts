/**
 * Read-only workflows (ADR-0254 §2).
 *
 * A workflow compiled from a playbook is regenerated from its source, so an
 * edit to the row would be silently thrown away on the next compile. Every
 * ordinary write path asks {@link assertWorkflowWritable} first; the compiler
 * that owns the row writes through its own path. To change the graph a person
 * detaches it, which duplicates the row without `derivedFrom` / `readOnly`.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"

export class WorkflowReadOnlyError extends Error {
  readonly code = "workflow_read_only"

  constructor(readonly workflowId: string) {
    super(
      `Workflow ${workflowId} is read-only: it is compiled from a playbook. Detach it to edit a copy.`
    )
    this.name = "WorkflowReadOnlyError"
  }
}

export function isWorkflowReadOnly(workflow: Pick<VisualWorkflow, "readOnly">): boolean {
  return workflow.readOnly === true
}

/** Throws {@link WorkflowReadOnlyError} when an ordinary write targets a read-only row. */
export function assertWorkflowWritable(workflow: Pick<VisualWorkflow, "id" | "readOnly">): void {
  if (isWorkflowReadOnly(workflow)) throw new WorkflowReadOnlyError(workflow.id)
}
