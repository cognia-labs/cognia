/**
 * `/plan to-workflow`, end to end (WF-24): resolve what the pure compiler
 * cannot know, compile, persist, link.
 *
 * `planWorkflowDraft` turns each step into the ordinary node that does the same
 * work, so the exported workflow runs on its own. Two facts live outside the
 * plan and are looked up here:
 *
 *   - which installed plugin registers each `tool_call` step's tool (the
 *     `action.plugin.invoke` node names its plugin, the plan step only names
 *     the tool);
 *   - nothing else: every other step carries its own content.
 *
 * After the workflow row exists the plan records a link to it
 * (`metadata.exportedWorkflows`). That is the whole relationship: the workflow
 * never reads or writes the plan, so editing or deleting the plan cannot
 * change it.
 *
 * Throws `PlanExportError` (a step with no standalone equivalent) and
 * `PlanSynthesizeError` (an invalid DAG) for the caller to explain; nothing is
 * written when either is thrown.
 */

import type { AgentPlan } from "@/types/agent/plan"
import { planWorkflowDraft, type PlanWorkflowDraft } from "./workflow-conversion"

export interface PlanWorkflowExportDeps {
  /** Plugin id registering `toolName`, or `undefined` when none does. */
  resolveToolOwner(toolName: string): Promise<string | undefined>
  /** Persist the draft as a new workflow row. */
  createWorkflow(draft: PlanWorkflowDraft): Promise<{ id: string }>
  /** Record the export on the plan. */
  recordExport(planId: string, workflowId: string): Promise<void>
}

export interface PlanWorkflowExportResult {
  workflowId: string
  /** Plan steps exported (a step may span more than one node). */
  stepCount: number
}

const defaultDeps: PlanWorkflowExportDeps = {
  async resolveToolOwner(toolName) {
    const { resolvePluginToolByName } = await import("@/lib/plugin/core/invoke-plugin-tool")
    return (await resolvePluginToolByName(toolName))?.pluginId
  },
  async createWorkflow(draft) {
    const { createWorkflow } = await import("@/lib/db/workflows")
    return createWorkflow(draft)
  },
  async recordExport(planId, workflowId) {
    const { getPlanRuntime } = await import("./runtime")
    await getPlanRuntime().recordWorkflowExport(planId, workflowId)
  },
}

/** Export `plan` as a standalone workflow and link it from the plan. */
export async function exportPlanAsWorkflow(
  plan: AgentPlan,
  deps: PlanWorkflowExportDeps = defaultDeps
): Promise<PlanWorkflowExportResult> {
  const pluginToolOwners = new Map<string, string>()
  for (const step of plan.steps) {
    if (step.params?.kind !== "tool_call" || !step.params.toolName) continue
    const toolName = step.params.toolName
    if (pluginToolOwners.has(toolName)) continue
    const owner = await deps.resolveToolOwner(toolName)
    if (owner) pluginToolOwners.set(toolName, owner)
  }
  // Compiles (and validates) before anything is written: a refused export
  // leaves no half-made workflow behind.
  const draft = planWorkflowDraft(plan, { pluginToolOwners })
  const workflow = await deps.createWorkflow(draft)
  await deps.recordExport(plan.id, workflow.id)
  return { workflowId: workflow.id, stepCount: plan.steps.length }
}
