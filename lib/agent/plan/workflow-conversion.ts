/**
 * Plan ⇄ VisualWorkflow conversions (ADR-0045 §2 / ADR-0011).
 *
 * `synthesize-workflow.ts` compiles a plan into an EPHEMERAL workflow for one
 * run of that plan (`__plan__:<planId>:<nonce>`, never persisted, its nodes
 * reading and writing the plan). These two functions are the durable,
 * user-facing direction:
 *
 *   • `planWorkflowDraft` — plan → a real, editable workflow that runs on its
 *     own (WF-24). Every step becomes the ordinary node that does the same
 *     work, carrying the step's content: an agent turn its prompt, an approval
 *     its question, a tool call its tool and input, a sub-workflow its target.
 *     Nothing in the result names the plan, so editing or deleting the plan
 *     never changes the workflow, and every run keeps its own step state in
 *     its own run history. A manual trigger root and a grid layout are added,
 *     because a workflow a human will open needs an entry point and
 *     non-overlapping positions.
 *
 *   • `planInputFromWorkflow` — workflow → plan. Deliberately ONE
 *     `sub_workflow` step (optionally behind an approval gate) rather than one
 *     step per node: plan step kinds and workflow node kinds are different
 *     vocabularies, and the thing that knows how to run nodes IS the
 *     orchestrator. Projecting node-by-node would either lose node semantics
 *     or duplicate the orchestrator inside the plan runtime.
 *
 * Both are pure — no Dexie — so the slash command owns persistence (and the
 * plugin-tool lookup) and these stay unit-testable.
 */

import type { VisualWorkflow, WorkflowEdge, WorkflowNode } from "@/types/workflow/visual"
import type { AgentPlan, CreatePlanInput, PlanStep, PlanStepKind } from "@/types/agent/plan"
import { synthesizePlanWorkflow } from "./synthesize-workflow"
import { planStepPrompt } from "./steps"

/** Horizontal / vertical spacing of the generated grid layout, in canvas units. */
const COLUMN_WIDTH = 320
const ROW_HEIGHT = 140

/** The fields `createWorkflow` accepts for a fresh row. */
export interface PlanWorkflowDraft {
  name: string
  description?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  tags: string[]
  settings: VisualWorkflow["settings"]
}

/** Why a plan cannot be exported as a standalone workflow. */
export type PlanExportErrorReason =
  /** A teammate turn exists only inside a plan or team run; no node does it alone. */
  | "teammate-step"
  /** A tool call whose tool no installed plugin registers. */
  | "tool-owner-unknown"
  /** A step without the settings its standalone node needs. */
  | "step-incomplete"

/**
 * A step that has no standalone workflow equivalent, or lacks what it needs.
 * Carries the step's title (and the tool, for a tool call) so the surface that
 * refuses the export can name exactly what to change.
 */
export class PlanExportError extends Error {
  constructor(
    readonly reason: PlanExportErrorReason,
    readonly step: Pick<PlanStep, "id" | "title" | "kind">,
    message: string,
    readonly toolName?: string
  ) {
    super(message)
    this.name = "PlanExportError"
  }

  get stepId(): string {
    return this.step.id
  }

  get stepKind(): PlanStepKind {
    return this.step.kind
  }
}

export interface PlanWorkflowDraftOptions {
  /**
   * Plugin that registers each `tool_call` step's tool, by tool name. The
   * exported `action.plugin.invoke` node names its plugin; the plan step only
   * names the tool, so the caller resolves it (`resolvePluginToolByName`).
   */
  pluginToolOwners?: ReadonlyMap<string, string>
}

/** One step's nodes: where its dependencies enter and its dependents leave. */
interface StepNodes {
  nodes: WorkflowNode[]
  entryId: string
  exit: { nodeId: string; handle?: string }
}

function node(
  id: string,
  type: string,
  label: string,
  params: Record<string, unknown>,
  extra: Partial<WorkflowNode["data"]> = {}
): WorkflowNode {
  return {
    id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label, params, ...extra },
  } as WorkflowNode
}

/** The run input a `sub_workflow` step's trigger payload carried. */
function subWorkflowInput(payload: unknown): unknown {
  return payload && typeof payload === "object" && "input" in payload
    ? (payload as { input?: unknown }).input
    : payload
}

/** The ordinary node(s) that do a step's work outside any plan. */
function stepNodes(plan: AgentPlan, step: PlanStep, options: PlanWorkflowDraftOptions): StepNodes {
  const single = (n: WorkflowNode, handle?: string): StepNodes => ({
    nodes: [n],
    entryId: n.id,
    exit: { nodeId: n.id, ...(handle ? { handle } : {}) },
  })
  const params = step.params
  switch (step.kind) {
    case "agent_turn":
      return single(
        node(step.id, "action.agent.turn", step.title, {
          prompt: planStepPrompt(step),
          toolsEnabled: true,
          ...(plan.characterId ? { characterId: plan.characterId } : {}),
        })
      )
    case "approval_gate": {
      const message =
        params?.kind === "approval_gate" && params.prompt ? params.prompt : step.description
      // Dependents follow the `approved` handle only: a rejection stops them,
      // as it stops the plan.
      return single(
        node(step.id, "action.approval.request", step.title, {
          title: step.title,
          ...(message ? { message } : {}),
        }),
        "approved"
      )
    }
    case "editor_review": {
      if (params?.kind !== "editor_review") {
        throw new PlanExportError(
          "step-incomplete",
          step,
          `Step "${step.title}" has no path and content to review.`
        )
      }
      const diffId = `${step.id}__diff`
      // The diff is a convenience, the review is the gate: a missing Pro IDE
      // must not skip the question, so the diff node continues on failure and
      // the approval carries the proposal as text either way.
      const diff = node(
        diffId,
        "action.editor.showDiff",
        params.title ?? step.title,
        {
          path: params.path,
          content: params.content,
          ...(params.title ? { title: params.title } : {}),
          ...(params.root ? { root: params.root } : {}),
        },
        { errorHandling: { onError: "continue" } }
      )
      const message = [
        params.prompt ?? step.description ?? "",
        `Proposed contents of ${params.path}:`,
        params.content,
      ]
        .filter(Boolean)
        .join("\n\n")
      const approval = node(step.id, "action.approval.request", step.title, {
        title: step.title,
        message,
      })
      return {
        nodes: [diff, approval],
        entryId: diffId,
        exit: { nodeId: step.id, handle: "approved" },
      }
    }
    case "sub_workflow": {
      if (params?.kind !== "sub_workflow" || !params.workflowId) {
        throw new PlanExportError(
          "step-incomplete",
          step,
          `Step "${step.title}" names no workflow to run.`
        )
      }
      const input = subWorkflowInput(params.triggerPayload)
      return single(
        node(step.id, "flow.subworkflow", step.title, {
          workflowId: params.workflowId,
          ...(input !== undefined ? { input } : {}),
        })
      )
    }
    case "tool_call": {
      const toolName = params?.kind === "tool_call" ? params.toolName : undefined
      const pluginId = toolName ? options.pluginToolOwners?.get(toolName) : undefined
      if (!toolName || !pluginId) {
        throw new PlanExportError(
          "tool-owner-unknown",
          step,
          `Step "${step.title}" calls ${toolName ? `tool '${toolName}'` : "no tool"}, which no installed plugin registers.`,
          toolName
        )
      }
      return single(
        node(step.id, "action.plugin.invoke", step.title, {
          pluginId,
          mode: "tool",
          toolName,
          args: params?.kind === "tool_call" ? params.input : {},
        })
      )
    }
    case "mcp_tool_call": {
      if (params?.kind !== "mcp_tool_call" || !params.serverId || !params.toolName) {
        throw new PlanExportError(
          "step-incomplete",
          step,
          `Step "${step.title}" names no MCP server and tool.`
        )
      }
      return single(
        node(step.id, "action.mcp.invokeTool", step.title, {
          serverId: params.serverId,
          toolName: params.toolName,
          args: params.input ?? {},
        })
      )
    }
    case "teammate_dispatch":
      // One teammate turn exists only inside a team or plan run (it claims a
      // teammate of a live team context), and no node does it alone:
      // `action.team.task.dispatch` needs the per-run TeamRunContext only the
      // team lifecycle registers (synthesizer-only), `action.team.run` runs a
      // whole team toward a goal rather than one teammate's turn, and
      // `action.team.delegate` hands work to a twin, a background or external
      // agent, or another team. Exporting any of them would change what the
      // step does, so the export is refused and names the step.
      throw new PlanExportError(
        "teammate-step",
        step,
        `Step "${step.title}" dispatches a teammate, which only runs inside the plan or its team. Run the plan instead, or change the step to an agent turn before exporting.`
      )
  }
}

/**
 * Compile a plan into a persistable, standalone workflow draft.
 *
 * Layout: steps are laid out in dependency "levels" (longest path from a root),
 * one column per level, so the canvas reads left-to-right the way the plan
 * executes. The manual trigger sits in its own leading column and feeds every
 * root step.
 *
 * Throws `PlanSynthesizeError` for an empty plan, an unknown dependency, or a
 * cycle — the same validation the run path performs — and `PlanExportError`
 * for a step with no standalone equivalent.
 */
export function planWorkflowDraft(
  plan: AgentPlan,
  options: PlanWorkflowDraftOptions = {}
): PlanWorkflowDraft {
  // Validates the DAG (empty / unknown dependency / cycle) and carries the
  // plan's error policy and concurrency into the workflow settings.
  const { workflow } = synthesizePlanWorkflow(plan)

  const stepById = new Map(plan.steps.map((s) => [s.id, s]))
  const level = new Map<string, number>()
  const levelOf = (id: string, seen: Set<string> = new Set()): number => {
    const cached = level.get(id)
    if (cached !== undefined) return cached
    // `synthesizePlanWorkflow` already rejected cycles; the guard keeps this
    // helper safe if it is ever called on unvalidated input.
    if (seen.has(id)) return 0
    seen.add(id)
    const deps = stepById.get(id)?.dependencies ?? []
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((d) => levelOf(d, seen) + 1))
    level.set(id, value)
    return value
  }

  const ordered = [...plan.steps].sort((a, b) => a.order - b.order)
  const built = new Map(ordered.map((s) => [s.id, stepNodes(plan, s, options)]))

  // A step that spans several nodes (an editor review's diff, then its
  // approval) takes one row per node in its column, in order.
  const rowCursor = new Map<number, number>()
  const nodes: WorkflowNode[] = []
  for (const s of ordered) {
    const col = levelOf(s.id)
    let row = rowCursor.get(col) ?? 0
    for (const n of built.get(s.id)!.nodes) {
      nodes.push({ ...n, position: { x: (col + 1) * COLUMN_WIDTH, y: row * ROW_HEIGHT } })
      row += 1
    }
    rowCursor.set(col, row)
  }

  const triggerId = `${plan.id}-trigger`
  const trigger = {
    id: triggerId,
    type: "trigger.manual",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: plan.title, params: {} },
  } as WorkflowNode

  const edges: WorkflowEdge[] = []
  for (const s of ordered) {
    const target = built.get(s.id)!
    // A step that spans two nodes (diff → approval) is wired internally.
    if (target.entryId !== s.id) {
      edges.push({
        id: `${target.entryId}->${s.id}`,
        source: target.entryId,
        target: s.id,
      } as WorkflowEdge)
    }
    if (s.dependencies.length === 0) {
      edges.push({
        id: `${triggerId}->${target.entryId}`,
        source: triggerId,
        target: target.entryId,
      } as WorkflowEdge)
      continue
    }
    for (const dep of s.dependencies) {
      const source = built.get(dep)!.exit
      edges.push({
        id: `${dep}->${s.id}`,
        source: source.nodeId,
        ...(source.handle ? { sourceHandle: source.handle } : {}),
        target: target.entryId,
      } as WorkflowEdge)
    }
  }

  return {
    name: plan.title,
    ...(plan.description ? { description: plan.description } : {}),
    nodes: [trigger, ...nodes],
    edges,
    // Tagged so an exported plan is findable in the library, and so a future
    // sweep can tell generated rows from hand-authored ones.
    tags: ["plan"],
    settings: workflow.settings,
  }
}

/** Minimal workflow shape `planInputFromWorkflow` reads. */
export type WorkflowSummary = Pick<VisualWorkflow, "id" | "name" | "description">

/**
 * Project a saved workflow into a plan that runs it as a `sub_workflow` step.
 *
 * `withApprovalGate` prepends an `approval_gate` step — the reason to wrap a
 * workflow in a plan at all is usually "let me review before this fires", and
 * the gate is answerable from the app-root `GateModalsHost`.
 */
export function planInputFromWorkflow(
  workflow: WorkflowSummary,
  opts: { sessionId: string; characterId?: string; withApprovalGate?: boolean }
): CreatePlanInput {
  const runStep = {
    title: workflow.name,
    kind: "sub_workflow" as const,
    params: { kind: "sub_workflow" as const, workflowId: workflow.id },
    ...(workflow.description ? { description: workflow.description } : {}),
  }
  const steps = opts.withApprovalGate
    ? [
        {
          title: `Approve running "${workflow.name}"`,
          kind: "approval_gate" as const,
          params: { kind: "approval_gate" as const },
        },
        { ...runStep, dependsOn: [0] },
      ]
    : [runStep]

  return {
    sessionId: opts.sessionId,
    ...(opts.characterId ? { characterId: opts.characterId } : {}),
    title: workflow.name.slice(0, 120),
    ...(workflow.description ? { description: workflow.description } : {}),
    source: "manual",
    // A sub_workflow step never resolves to the in-session driver, but pin the
    // mode explicitly so the intent survives a future strategy change.
    executionMode: "orchestrated",
    steps,
    metadata: { workflowId: workflow.id },
  }
}
