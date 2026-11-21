/**
 * What a workflow must satisfy before a version of it can become active.
 *
 * Publishing used to check only the graph envelope (`validateWorkflow`), so a
 * graph whose Problems panel listed parameter errors — the same errors that
 * block the editor's Run button — could still be minted and pointed to by the
 * production deployment. The gate now runs the editor's diagnostics engine and
 * refuses every error-severity finding: node parameter errors, broken edges,
 * dangling expression references, undeclared credentials and synthesizer-only
 * nodes.
 *
 * Only `checkKindAvailability` is left out: whether a plugin kind is
 * registered describes this process, not the definition, and the Host that
 * runs the version can hold a different plugin set (the runtime fails such a
 * node at execution with its own message). Desktop-only warnings are not
 * errors and never block.
 *
 * One function so every activation path (publish, rollback) and every later
 * rule share the same gate and the same structured refusal.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import { validateWorkflow } from "@/lib/workflow/definition/validate"
import { runDiagnostics } from "@/lib/workflow/diagnostics/engine"

/** One reason a workflow cannot become an active version. */
export interface WorkflowPublishProblem {
  /** Diagnostic code (`nodeParam`, `credentialMissing`, …) or a gate-local code. */
  code: string
  nodeId?: string
  edgeId?: string
  field?: string
  /** English detail for logs and API callers; the editor renders its own copy. */
  message: string
}

export class WorkflowPublishBlockedError extends Error {
  readonly code = "workflow-publish-blocked" as const

  constructor(
    readonly workflowId: string,
    readonly problems: readonly WorkflowPublishProblem[]
  ) {
    super(
      `publishWorkflow: workflow ${workflowId} cannot be published: ${problems
        .map((problem) => problem.message)
        .join("; ")}`
    )
    this.name = "WorkflowPublishBlockedError"
  }
}

export function isWorkflowPublishBlockedError(
  error: unknown
): error is WorkflowPublishBlockedError {
  return error instanceof WorkflowPublishBlockedError
}

function describeLocation(problem: Omit<WorkflowPublishProblem, "message">): string {
  if (problem.nodeId && problem.field) return `node ${problem.nodeId} field ${problem.field}`
  if (problem.nodeId) return `node ${problem.nodeId}`
  if (problem.edgeId) return `edge ${problem.edgeId}`
  return "workflow"
}

/**
 * Every reason `workflow` cannot be published, in a stable order. Pure and
 * synchronous, so it can run inside the publish transaction.
 */
export function collectWorkflowPublishProblems(workflow: VisualWorkflow): WorkflowPublishProblem[] {
  const envelope = validateWorkflow(workflow)
  // A definition the schema rejects cannot be fed to the diagnostics checks.
  if (!envelope.ok) {
    return envelope.errors.map((error) => ({ code: "invalidWorkflow", message: error }))
  }

  const problems: WorkflowPublishProblem[] = []
  for (const node of workflow.nodes) {
    if (node.type === "data.code" && node.typeVersion === 1) {
      problems.push({
        code: "legacyCodeNode",
        nodeId: node.id,
        message: `node ${node.id} uses data.code@1; migrate it to the isolated data.code@2 executor before publishing`,
      })
    }
  }

  const { diagnostics } = runDiagnostics({ workflow, isWeb: false })
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error") continue
    const location = {
      code: diagnostic.code,
      ...(diagnostic.nodeId ? { nodeId: diagnostic.nodeId } : {}),
      ...(diagnostic.edgeId ? { edgeId: diagnostic.edgeId } : {}),
      ...(diagnostic.field ? { field: diagnostic.field } : {}),
    }
    problems.push({ ...location, message: `${diagnostic.code} at ${describeLocation(location)}` })
  }
  return problems
}

/** Throw {@link WorkflowPublishBlockedError} unless `workflow` may become active. */
export function assertWorkflowPublishable(workflow: VisualWorkflow): void {
  const problems = collectWorkflowPublishProblems(workflow)
  if (problems.length > 0) throw new WorkflowPublishBlockedError(workflow.id, problems)
}
