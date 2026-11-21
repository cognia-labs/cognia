/**
 * Pin a plan's `sub_workflow` steps to published workflow versions
 * (ADR-0045 amendment, 2026-11-20).
 *
 * A plan approval is a person agreeing to what will run. A step that only
 * names a workflow id would run whatever the workflow's draft says at run
 * time, so an edit made after the approval, or a different publication,
 * would run without anyone approving it. Each `sub_workflow` step therefore
 * carries the production deployment it was approved against: version,
 * deployment revision and the dependency lock, resolved the same way every
 * other formal caller resolves them. Execution admits exactly that binding.
 *
 * Pure: the resolver is injected. The plan runtime supplies the workflow
 * module's `createPublishedWorkflowDependencyBinding`.
 */

import type { PlanStep } from "@/types/agent/plan"
import type { WorkflowDependencyBinding } from "@/types/workflow/deployment"

/** Why a step's workflow cannot be bound. */
export type PlanApprovalBlockReason =
  /** The workflow has no active production deployment. */
  | "not-published"
  /** It is published, but a workflow it calls is not (or the calls form a cycle). */
  | "dependencies-unavailable"

/**
 * Approval (or creating an already-approved plan) was refused because a
 * `sub_workflow` step's workflow cannot be admitted as a published version.
 * Nothing about the plan changed.
 */
export class PlanApprovalBlockedError extends Error {
  readonly retryable = false

  constructor(
    readonly reason: PlanApprovalBlockReason,
    readonly stepId: string,
    readonly stepTitle: string,
    readonly workflowId: string,
    detail: string
  ) {
    super(
      reason === "not-published"
        ? `Plan step "${stepTitle}" runs workflow ${workflowId}, which is not published. Publish it, then approve the plan again.`
        : `Plan step "${stepTitle}" runs workflow ${workflowId}, which cannot be admitted: ${detail}`
    )
    this.name = "PlanApprovalBlockedError"
  }
}

/**
 * The `plan.approvalBlocked.*` message for a refusal, with its values. Every
 * surface that approves a plan says the same thing: the dock and composer
 * toasts, and the notification a notification-button approval leaves.
 */
export function planApprovalBlockedMessage(error: PlanApprovalBlockedError): {
  key: "notPublished" | "dependenciesUnavailable"
  values: { step: string; workflow: string }
} {
  return {
    key: error.reason === "not-published" ? "notPublished" : "dependenciesUnavailable",
    values: { step: error.stepTitle, workflow: error.workflowId },
  }
}

export type SubWorkflowBindingResolution =
  | { ok: true; binding: WorkflowDependencyBinding }
  | { ok: false; reason: PlanApprovalBlockReason; detail: string }

export interface SubWorkflowBindingDeps {
  /** Resolve the active production deployment graph for one workflow. */
  resolve(workflowId: string): Promise<SubWorkflowBindingResolution>
}

/**
 * Which steps to (re)bind.
 *
 *  - `approve`: every `sub_workflow` step, freshly. The person approves now,
 *    so the pin is what is published now.
 *  - `edit`: only steps whose workflow has no binding yet, or whose binding
 *    names another workflow. An edit to an approved plan keeps the versions
 *    its untouched steps were approved against.
 */
export type SubWorkflowBindingMode = "approve" | "edit"

/** True when the plan has a `sub_workflow` step the given mode would bind. */
function needsBinding(step: PlanStep, mode: SubWorkflowBindingMode): boolean {
  if (step.params?.kind !== "sub_workflow" || !step.params.workflowId) return false
  if (mode === "approve") return true
  return step.params.binding?.workflowId !== step.params.workflowId
}

/**
 * An editor that rebuilds a step's params from its own fields drops the
 * binding it never showed. In `edit` mode a step keeps the binding its
 * previous version had (same step id, same workflow), so only a step that
 * really names another workflow is re-pinned.
 */
function carryBindings(steps: PlanStep[], previous: readonly PlanStep[]): PlanStep[] {
  const before = new Map(previous.map((step) => [step.id, step]))
  let changed = false
  const carried = steps.map((step) => {
    if (step.params?.kind !== "sub_workflow" || step.params.binding) return step
    const prior = before.get(step.id)
    const binding = prior?.params?.kind === "sub_workflow" ? prior.params.binding : undefined
    if (!binding || binding.workflowId !== step.params.workflowId) return step
    changed = true
    return { ...step, params: { ...step.params, binding } }
  })
  return changed ? carried : steps
}

/**
 * Return the steps with every selected `sub_workflow` step pinned. Throws
 * {@link PlanApprovalBlockedError} for the first step that cannot be pinned,
 * before any step is changed. `previous` (edit mode) is the plan's steps
 * before the edit, whose bindings carry over to the same steps.
 */
export async function bindSubWorkflowSteps(
  input: PlanStep[],
  mode: SubWorkflowBindingMode,
  deps: SubWorkflowBindingDeps,
  previous: readonly PlanStep[] = []
): Promise<PlanStep[]> {
  const steps = mode === "edit" ? carryBindings(input, previous) : input
  if (!steps.some((step) => needsBinding(step, mode))) return steps
  const resolved = new Map<string, WorkflowDependencyBinding>()
  for (const step of steps) {
    if (!needsBinding(step, mode) || step.params?.kind !== "sub_workflow") continue
    const workflowId = step.params.workflowId
    if (resolved.has(workflowId)) continue
    const result = await deps.resolve(workflowId)
    if (!result.ok) {
      throw new PlanApprovalBlockedError(
        result.reason,
        step.id,
        step.title,
        workflowId,
        result.detail
      )
    }
    resolved.set(workflowId, result.binding)
  }
  return steps.map((step) => {
    if (!needsBinding(step, mode) || step.params?.kind !== "sub_workflow") return step
    const binding = resolved.get(step.params.workflowId)
    return binding ? { ...step, params: { ...step.params, binding } } : step
  })
}
