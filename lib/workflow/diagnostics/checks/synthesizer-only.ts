/**
 * Synthesizer-only node check.
 *
 * A handful of kinds are emitted by the agent-team and plan synthesizers and
 * cannot run anywhere else: their executors resolve a per-run context
 * (`TeamRunContext` / `PlanRunContext`) that only `runTeamLifecycle` and the
 * plan runtime register. Hand-placed, they threw
 * `no TeamRunContext registered for runId=…` at execution time, which reads as
 * a host bug rather than as "this node is not yours to place".
 *
 * The catalog's `hidden` flag keeps them out of the palette, so the normal way
 * to acquire one is to open or copy a synthesized graph. This check is what
 * tells the author, at edit time, which of those nodes their own Run button
 * cannot drive. (`/plan to-workflow` exports plan steps as ordinary nodes, so
 * it never produces one.)
 */

import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { makeDiagnostic } from "../diagnostic-id"
import type { Diagnostic } from "../types"

/**
 * Kind to the lifecycle that owns it. `action.plan.step.dispatch` runs only
 * inside its plan's own run (`__plan__:<planId>:…`), which is never an
 * editable workflow.
 */
const REQUIRED_LIFECYCLE: Partial<Record<WorkflowNodeKind, "team" | "plan">> = {
  "action.plan.step.dispatch": "plan",
  "action.team.task.dispatch": "team",
  "action.team.task.review": "team",
  "action.team.reconcile": "team",
  "pattern.multi-modal-sweep": "team",
  "pattern.loop-until-dry": "team",
  "pattern.adversarial-verify": "team",
  "pattern.judge-panel": "team",
  "pattern.completeness-critic": "team",
  "pattern.synthesize": "team",
}

export function checkSynthesizerOnly(wf: VisualWorkflow): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const node of wf.nodes) {
    const lifecycle = REQUIRED_LIFECYCLE[node.type as WorkflowNodeKind]
    if (!lifecycle) continue
    out.push(
      makeDiagnostic({
        severity: "error",
        code: "synthesizerOnly",
        nodeId: node.id,
        messageParams: { lifecycle },
      })
    )
  }
  return out
}
