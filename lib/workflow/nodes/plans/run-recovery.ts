/**
 * Crash recovery for a plan's own runs (ADR-0045, ADR-0061).
 *
 * A plan executes as a synthesized `__plan__:<planId>:<nonce>` workflow run
 * driven by the plan runtime, which registers the run's step context, wires
 * pause / cancel into the run's abort signal and moves the plan to its
 * terminal status when the run ends. A process that dies mid-run loses all
 * three. Replaying such a run as a plain workflow would execute its steps and
 * leave the plan `executing` forever, so the boot scan hands it back to the
 * plan runtime instead (`PlanRuntime.resumePlanRun`), which continues it under
 * the same run id with that driver restored.
 *
 * Installed by each composition root that resumes runs (the renderer's
 * workflow runtime provider and the headless brain), before the scan.
 */

import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { planIdOfPlanWorkflowId } from "@/lib/agent/plan/synthesize-workflow"
import {
  registerRunRecoveryOwner,
  type RunRecoveryOwner,
} from "@/lib/workflow/runtime/resume-controller"

export const planRunRecoveryOwner: RunRecoveryOwner = {
  id: "agent-plan",
  owns: (row) =>
    planIdOfPlanWorkflowId(row.workflowId) !== undefined ||
    planIdOfPlanWorkflowId(row.snapshot?.id) !== undefined,
  resume: (row) => getPlanRuntime().resumePlanRun(row),
}

/** Route crashed plan runs to the plan runtime. Returns the unregister. */
export function installPlanRunRecovery(): () => void {
  return registerRunRecoveryOwner(planRunRecoveryOwner)
}
