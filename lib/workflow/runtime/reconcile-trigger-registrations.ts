/** Shared projection entry point for database saves and both runtime roots. */
import type { VisualWorkflow } from "@/types/workflow/visual"
import { listWorkflows } from "@/lib/db/workflows"
import { resolveWorkflowDeployment } from "@/lib/db/workflow-deployments"
import { syncWorkflowTriggers, unsyncWorkflowTriggers } from "./webhook-bridge"
import { recordTriggerRegistration } from "./trigger-registration-health"

export type WorkflowTriggerProjectionResult = { ok: true } | { ok: false; error: string }

interface ReconcileOptions {
  signal?: AbortSignal
  log?: (level: "info" | "warn", message: string) => void
}

export async function projectWorkflowTriggerRegistrations(
  workflow: VisualWorkflow,
  options: ReconcileOptions = {}
): Promise<WorkflowTriggerProjectionResult | undefined> {
  if (options.signal?.aborted) return
  let deploymentResolved = false
  try {
    const deployed = await resolveWorkflowDeployment(workflow.id)
    if (options.signal?.aborted) return
    deploymentResolved = true
    if (deployed) await syncWorkflowTriggers(deployed.workflow, { signal: options.signal })
    else await unsyncWorkflowTriggers(workflow)
    if (options.signal?.aborted) return
    return { ok: true }
  } catch (error) {
    if (options.signal?.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    // Lookup can fail before the bridge sees any trigger; bridge failures
    // already retain each sibling's independent registration outcome.
    if (!deploymentResolved) {
      for (const node of workflow.nodes.filter((node) => node.type.startsWith("trigger."))) {
        recordTriggerRegistration({
          workflowId: workflow.id,
          triggerId: node.id,
          status: "failed",
          error: message,
        })
      }
    }
    return { ok: false, error: message }
  }
}

export async function reconcileWorkflowTriggerRegistrations(options: ReconcileOptions = {}) {
  const results: Array<WorkflowTriggerProjectionResult & { workflowId: string }> = []
  if (options.signal?.aborted) return results
  const workflows = await listWorkflows()
  for (const workflow of workflows) {
    if (options.signal?.aborted) break
    if (workflow.isTemplate || workflow.isBuiltIn) continue
    const result = await projectWorkflowTriggerRegistrations(workflow, options)
    if (result) results.push({ workflowId: workflow.id, ...result })
  }
  if (!options.signal?.aborted) {
    const failedIds = results.filter((result) => !result.ok).map((result) => result.workflowId)
    const message = `workflow trigger reconciliation: ${results.length} workflows, ${failedIds.length} failed; failed workflow ids: ${failedIds.join(", ") || "none"}`
    if (options.log) options.log(failedIds.length ? "warn" : "info", message)
    else if (failedIds.length) console.warn(message)
    else console.info(message)
  }
  return results
}
