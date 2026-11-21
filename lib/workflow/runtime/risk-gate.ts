/**
 * Engine-level risk gate for workflow nodes (ADR-0070 Phase 3).
 *
 * Before the orchestrator runs a risky node, this asks a human — unless the
 * workflow already asks one upstream. It is the workflow surface's expression of
 * the same thesis as Phases 1 and 2: classify deterministically, then raise the
 * checkpoint the surface already has. There is no new gate mechanism here — the
 * wait is `action.approval.request`'s own machinery
 * (`registerPendingApproval` + a `step.long_running.checkpoint` + `subscribeWake`),
 * reused verbatim so an auto-gate resumes after a crash exactly like an authored
 * approval node does, and the same pending-approval UI answers it.
 *
 * Three rules:
 *
 *  - **De-dup.** If an `action.approval.request` upstream of this node ran in
 *    THIS execution scope and a human approved it, do not ask twice. Being an
 *    ancestor in the graph is not enough: an approval that was rejected, timed
 *    out or never ran (a skipped branch) approves nothing. Inside a loop the
 *    scope is the run plus the enclosing iterations, so one iteration's
 *    approval never covers the next.
 *  - **Headless is fail-closed.** A run no human is watching — an automatic
 *    trigger (cron, webhook, file, event subscriptions: source `"trigger"`),
 *    IM, API, schedule or bot — has nobody to answer, so a risky ungated node
 *    fails the run naming its surfaces, rather than hanging on a modal no one
 *    will see. Same posture as the Team and /goal phases.
 *  - **Low-risk nodes never touch this path** — no checkpoint, no registry entry,
 *    no wall-clock cost.
 */

import type { VisualWorkflow, WorkflowNode, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { listRunEvents, appendEvent } from "./event-log"
import { findApprovalCheckpoint } from "./long-step-runner"
import {
  approvalId,
  registerPendingApproval,
  type ApprovalResponse,
  type PendingApproval,
} from "./approval-registry"
import { waitForWorkflowWaitpoint } from "./waitpoint-repository"
import { notifyApprovalRequested, notifyApprovalResolved } from "./approval-notify"
import { ancestorsOf } from "./run-single-node"
import { classifyNodeRisk } from "./node-risk"

/**
 * Distinct from `APPROVAL_CHECKPOINT_KEY` so a resumed run can tell an
 * auto-gate apart from an authored approval node on the same step id.
 */
export const RISK_GATE_CHECKPOINT_KEY = "risk-gate"

/** Wait budget before an unanswered gate rejects. Mirrors the approval node. */
const DEFAULT_TIMEOUT_MS = 3_600_000

/** The trigger sources with a human in front of the app. */
const INTERACTIVE_SOURCES: ReadonlyArray<WorkflowTriggeredFrom["source"]> = [
  "ui",
  "desktop",
  "chat",
]

export class RiskGateRejected extends Error {
  constructor(
    readonly nodeId: string,
    readonly reason: string
  ) {
    super(reason)
    this.name = "RiskGateRejected"
  }
}

export interface RiskGateInput {
  workflow: VisualWorkflow
  node: WorkflowNode
  runId: string
  triggeredBy?: WorkflowTriggeredFrom
  /**
   * `action.approval.request` node ids that executed and were approved in the
   * scope this node runs in (the run, plus the enclosing loop iterations).
   */
  approvedApprovalIds: ReadonlySet<string>
  /**
   * Identity of this execution of the node: its id at top level, its full
   * memo key inside a loop iteration, so each iteration asks on its own.
   */
  stepKey?: string
  signal?: AbortSignal
}

/**
 * True when the workflow opts into risk gating.
 *
 * **Migration (ADR-0070 decision #2).** `undefined` → OFF. Unlike Team and
 * /goal, the workflow default is opt-IN: a workflow authored before this shipped
 * has no `riskGating` field, and flipping it on retroactively would start
 * pausing (interactive) or failing (headless) automations users already rely on
 * — `plugins/zhihu-content-pipeline`'s template ships a real
 * `action.system.terminal` node, so this is not hypothetical. The workflow
 * editor stamps `riskGating: true` on newly created workflows instead.
 */
export function isRiskGatingEnabled(workflow: Pick<VisualWorkflow, "settings">): boolean {
  return workflow.settings?.riskGating === true
}

/** Is a human watching this run? */
export function isInteractiveRun(triggeredBy?: WorkflowTriggeredFrom): boolean {
  // Undefined = a plain UI run (the orchestrator defaults `triggeredBySource`
  // to "ui" for exactly this case).
  if (!triggeredBy) return true
  return INTERACTIVE_SOURCES.includes(triggeredBy.source)
}

/**
 * Every node whose completion precedes `nodeId`: its graph ancestors and, for
 * a loop-body node, each enclosing loop container and that container's own
 * ancestors (an approval before the loop gates the whole loop).
 */
export function gatingAncestorsOf(workflow: VisualWorkflow, nodeId: string): Set<string> {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n] as const))
  const result = ancestorsOf(workflow, nodeId)
  let parentId = byId.get(nodeId)?.parentId
  const seen = new Set<string>()
  while (parentId !== undefined && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    if (parent.type === "flow.loop") {
      result.add(parent.id)
      for (const id of ancestorsOf(workflow, parent.id)) result.add(id)
    }
    parentId = parent.parentId
  }
  return result
}

/** Did a human approve an authored approval node upstream of this one, in this scope? */
export function hasApprovedAncestor(
  workflow: VisualWorkflow,
  nodeId: string,
  approvedApprovalIds: ReadonlySet<string>
): boolean {
  if (approvedApprovalIds.size === 0) return false
  const ancestors = gatingAncestorsOf(workflow, nodeId)
  return workflow.nodes.some(
    (n) =>
      n.type === "action.approval.request" && ancestors.has(n.id) && approvedApprovalIds.has(n.id)
  )
}

/**
 * Gate a node if its risk warrants it. Resolves normally when the node may
 * proceed (low risk, gating off, already gated upstream, or a human approved);
 * throws {@link RiskGateRejected} when the run must not continue.
 */
export async function applyNodeRiskGate(input: RiskGateInput): Promise<void> {
  const { workflow, node, runId, triggeredBy, signal } = input
  if (!isRiskGatingEnabled(workflow)) return

  const assessment = classifyNodeRisk(node)
  if (assessment.tier === "low") return
  if (hasApprovedAncestor(workflow, node.id, input.approvedApprovalIds)) {
    return
  }

  const surfaces = assessment.surfaces.map((s) => s.id).join(", ")

  // ── Headless: fail closed ──
  if (triggeredBy && !isInteractiveRun(triggeredBy)) {
    throw new RiskGateRejected(
      node.id,
      `Node ${node.id} (${node.type}) touches ${assessment.reason} and this run is headless (source=${triggeredBy.source}); add an action.approval.request upstream, run it interactively, or set riskGating=false on the workflow`
    )
  }

  // ── Interactive: reuse the approval node's wait, verbatim ──
  const id = approvalId(runId, input.stepKey ?? node.id)

  let requestedAt = Date.now()
  let fresh = true
  try {
    const events = await listRunEvents(runId)
    const prior = findApprovalCheckpoint(events, node.id, RISK_GATE_CHECKPOINT_KEY, id)
    if (prior) {
      requestedAt = prior.requestedAt
      fresh = false
    }
  } catch {
    // No readable event log (unit-level runs) — treat as fresh.
  }

  const timeoutAt = requestedAt + DEFAULT_TIMEOUT_MS
  const entry: PendingApproval = {
    approvalId: id,
    runId,
    workflowId: workflow.id,
    stepId: node.id,
    title: `Approve ${node.type}?`,
    message: `This step touches ${surfaces}. Approve to run it, or reject to stop the run.`,
    requestedAt,
    timeoutAt,
    kind: "risk_gate",
  }

  await registerPendingApproval(entry)
  if (fresh) {
    try {
      await appendEvent({
        runId,
        stepId: node.id,
        type: "step.long_running.checkpoint",
        payload: {
          checkpointKey: RISK_GATE_CHECKPOINT_KEY,
          state: { approvalId: id, requestedAt },
        },
      })
    } catch (err) {
      console.warn("risk gate: checkpoint persistence failed", err)
    }
    await notifyApprovalRequested(entry)
  }

  // The durable row decides, even past the deadline: a decision persisted in
  // time stands after a late resume, and a still-pending row past its
  // deadline is expired by the wait itself (an unanswered gate is a
  // rejection, never a silent pass).
  const waitpoint = await waitForWorkflowWaitpoint(id, { signal, cancelOnAbort: true })
  if (waitpoint.status === "timed_out") {
    throw new RiskGateRejected(node.id, `Risk gate for ${node.id} timed out unanswered`)
  }
  if (waitpoint.status === "cancelled") {
    throw new RiskGateRejected(node.id, `Risk gate for ${node.id} was cancelled`)
  }
  const resolution = waitpoint.resolution
  if (!resolution || (resolution.outcome !== "approved" && resolution.outcome !== "rejected")) {
    throw new RiskGateRejected(node.id, `Risk gate for ${node.id} has an invalid decision`)
  }
  const response: ApprovalResponse = {
    decision: resolution.outcome,
    respondedBy: resolution.respondedBy ?? "unknown",
  }
  void notifyApprovalResolved(entry, response.decision)
  if (response.decision !== "approved") {
    throw new RiskGateRejected(
      node.id,
      `Risk gate for ${node.id} (${surfaces}) rejected by ${response.respondedBy}`
    )
  }
}
