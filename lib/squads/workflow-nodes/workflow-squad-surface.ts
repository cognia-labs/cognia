/**
 * The launch surface of a Squad run a workflow step starts (`action.team.run`,
 * `action.team.compose` with `autoStart`).
 *
 * The workflow run is the Squad run's parent. A workflow started from an IM
 * conversation (`startWorkflowFromIM` mirrors the origin onto
 * `trigger.binding`) runs the Squad headless and fans its progress and result
 * back there; both identifiers are needed. The workflow's knowledge grant and
 * a team-completion fan-out's chain depth go with the run, so recovery
 * re-enters it with the same reading scope and loop guard.
 */

import type { StepExecutionContext } from "@/types/workflow/visual"
import type { SquadImConversation, SquadStartSurface } from "../squad/build-start-input"

export type WorkflowSquadSurface = Extract<SquadStartSurface, { kind: "workflow" }>

export interface WorkflowSquadSurfaceDeps {
  resolveKnowledgeAccess?: (
    ctx: StepExecutionContext
  ) => Promise<WorkflowSquadSurface["knowledgeAccess"]>
}

async function defaultResolveKnowledgeAccess(ctx: StepExecutionContext) {
  const { resolveWorkflowKnowledgeAccess } = await import("@/lib/workflow/knowledge/access")
  return resolveWorkflowKnowledgeAccess(ctx)
}

export async function workflowSquadSurface(
  ctx: StepExecutionContext,
  deps: WorkflowSquadSurfaceDeps = {}
): Promise<WorkflowSquadSurface> {
  const binding = ctx.trigger.binding
  const conversation: SquadImConversation | undefined =
    binding?.adapterId && binding?.conversationKey
      ? {
          adapterId: binding.adapterId,
          conversationKey: binding.conversationKey,
          ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
        }
      : undefined
  const payload = ctx.trigger.payload as { chainDepth?: unknown } | undefined
  const triggerChainDepth = typeof payload?.chainDepth === "number" ? payload.chainDepth : 0
  const knowledgeAccess = await (deps.resolveKnowledgeAccess ?? defaultResolveKnowledgeAccess)(ctx)
  return {
    kind: "workflow",
    workflowRunId: ctx.runId,
    ...(conversation ? { conversation } : {}),
    ...(knowledgeAccess ? { knowledgeAccess } : {}),
    ...(triggerChainDepth ? { triggerChainDepth } : {}),
  }
}
