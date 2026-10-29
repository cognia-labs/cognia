/**
 * Pure helpers for turning `CreatePlanStepInput[]` (index-based deps) into
 * persisted `PlanStep[]` (id-based deps), and for keeping the denormalised
 * plan counts / current-step cursor in sync. Kept separate from the runtime
 * so they're unit-testable without Dexie. (ADR-0045)
 */

import type { AgentPlan, CreatePlanStepInput, PlanStep, PlanStepStatus } from "@/types/agent/plan"
import { computePlanCounts } from "@/types/agent/plan"

/** Max characters kept from a step title (Dexie row hygiene + card layout). */
export const MAX_PLAN_STEP_TITLE_LEN = 200

/**
 * Turn an ordered list of titles into a linear `agent_turn` chain: step *i*
 * depends on step *i-1*, titles clamped to {@link MAX_PLAN_STEP_TITLE_LEN}.
 *
 * Every plan producer that has only prose to work with — the ExitPlanMode
 * capture, the planner LLM, the goal projection, the `/plan new` command, the
 * composer dialog, an inline approval-card edit, and a refinement — needs
 * exactly this shape. It lived inline in all seven, so a change to the chain
 * (or the clamp) had to be made seven times to stay consistent.
 */
export function linearAgentTurnSteps(titles: readonly string[]): CreatePlanStepInput[] {
  return titles.map((title, i) => ({
    title: title.slice(0, MAX_PLAN_STEP_TITLE_LEN),
    kind: "agent_turn" as const,
    ...(i > 0 ? { dependsOn: [i - 1] } : {}),
  }))
}

/**
 * Re-derive creation inputs after a refinement rewrote a plan's step titles.
 *
 * The planner only returns titles. A plan that was a plain `agent_turn` chain
 * stays one ({@link linearAgentTurnSteps}). Any other plan keeps its shape
 * where it can: a refined title equal to an existing step's keeps that step's
 * kind, params, description, issue and the dependencies that still exist; a new
 * title becomes an `agent_turn` after the step before it. Flattening every
 * refined plan to a chain silently turned teammate / tool / gate steps into
 * prose turns.
 */
export function refinedStepInputs(
  previous: readonly PlanStep[],
  titles: readonly string[]
): CreatePlanStepInput[] {
  const ordered = [...previous].sort((a, b) => a.order - b.order)
  const chain = ordered.every(
    (step, i) =>
      step.kind === "agent_turn" &&
      (step.dependencies.length === 0 ||
        (i > 0 && step.dependencies.length === 1 && step.dependencies[0] === ordered[i - 1]!.id))
  )
  if (chain) return linearAgentTurnSteps(titles)

  const byTitle = new Map<string, PlanStep[]>()
  for (const step of ordered) byTitle.set(step.title, [...(byTitle.get(step.title) ?? []), step])
  const matched = titles.map((title) => byTitle.get(title)?.shift())
  const indexOf = new Map<string, number>()
  matched.forEach((step, i) => {
    if (step) indexOf.set(step.id, i)
  })
  return titles.map((rawTitle, i) => {
    const title = rawTitle.slice(0, MAX_PLAN_STEP_TITLE_LEN)
    const step = matched[i]
    if (!step)
      return { title, kind: "agent_turn" as const, ...(i > 0 ? { dependsOn: [i - 1] } : {}) }
    const dependsOn = step.dependencies
      .map((id) => indexOf.get(id))
      .filter((index): index is number => index !== undefined)
    return {
      title,
      kind: step.kind,
      ...(step.description ? { description: step.description } : {}),
      ...(step.params ? { params: step.params } : {}),
      ...(step.issueId ? { issueId: step.issueId } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    }
  })
}

/**
 * Materialise creation inputs into full steps: assign stable ids, resolve
 * `dependsOn` index references into dependency ids (dropping self-refs and
 * out-of-range indices), and stamp the initial `pending` status + 0-based
 * `order`. Cycle validation is deferred to `synthesizePlanWorkflow` (Kahn),
 * which is the single source of truth for DAG legality.
 */
export function materializeSteps(inputs: CreatePlanStepInput[]): PlanStep[] {
  const ids = inputs.map(() => crypto.randomUUID())
  return inputs.map((input, i) => {
    const dependencies = (input.dependsOn ?? [])
      .filter((d) => Number.isInteger(d) && d >= 0 && d < ids.length && d !== i)
      .map((d) => ids[d])
    const step: PlanStep = {
      id: ids[i],
      title: input.title,
      description: input.description,
      kind: input.kind,
      status: "pending",
      order: i,
      dependencies,
      params: input.params,
      attempts: 0,
      estimatedDurationMs: input.estimatedDurationMs,
      ...(input.issueId ? { issueId: input.issueId } : {}),
    }
    return step
  })
}

/**
 * Apply a status (and optional field patch) to one step, returning a new step
 * array plus the recomputed plan counts and current-step cursor. The cursor
 * points at the first `in_progress` step, else the first non-terminal step in
 * `order`, else undefined when everything is terminal.
 */
export function applyStepStatus(
  steps: PlanStep[],
  stepId: string,
  status: PlanStepStatus,
  patch: Partial<Omit<PlanStep, "id" | "status">> = {}
): { steps: PlanStep[]; totalSteps: number; completedSteps: number; currentStepId?: string } {
  const next = steps.map((s) => (s.id === stepId ? { ...s, ...patch, status } : s))
  const counts = computePlanCounts(next)
  const ordered = [...next].sort((a, b) => a.order - b.order)
  const inProgress = ordered.find((s) => s.status === "in_progress")
  const nextOpen = ordered.find(
    (s) => s.status !== "completed" && s.status !== "failed" && s.status !== "skipped"
  )
  return {
    steps: next,
    totalSteps: counts.totalSteps,
    completedSteps: counts.completedSteps,
    currentStepId: (inProgress ?? nextOpen)?.id,
  }
}

/**
 * Skip one step AND take it out of the dependency chain: it becomes `skipped`
 * and every step that depended on it now depends on its prerequisites instead
 * (transitively, deduplicated, order preserved).
 *
 * Why the rewire: {@link nextRunnableStep} deliberately treats a skipped
 * dependency as blocking — that is how a step bypassed by a branch stops the
 * steps built on it. A user who skips a broken step is saying the opposite:
 * "carry on without it". Without the rewire, skipping step 2 of a linear plan
 * would leave step 3 waiting on a step that will never complete, and the plan
 * would end `failed` the moment it resumed.
 */
export function skipStepInDag(
  steps: PlanStep[],
  stepId: string,
  patch: Partial<Omit<PlanStep, "id" | "status" | "dependencies">> = {}
): ReturnType<typeof applyStepStatus> {
  const skipped = steps.find((s) => s.id === stepId)
  if (!skipped) return applyStepStatus(steps, stepId, "skipped", patch)
  const inherited = skipped.dependencies.filter((dep) => dep !== stepId)
  const rewired = steps.map((s) => {
    if (s.id === stepId || !s.dependencies.includes(stepId)) return s
    const next: string[] = []
    for (const dep of s.dependencies) {
      const replacement = dep === stepId ? inherited : [dep]
      for (const id of replacement) {
        if (id !== s.id && !next.includes(id)) next.push(id)
      }
    }
    return { ...s, dependencies: next }
  })
  return applyStepStatus(rewired, stepId, "skipped", patch)
}

/**
 * True when every step has reached a terminal status. Used by the driver /
 * orchestrator to decide whether the plan as a whole is done.
 */
export function allStepsTerminal(plan: Pick<AgentPlan, "steps">): boolean {
  return plan.steps.every(
    (s) => s.status === "completed" || s.status === "failed" || s.status === "skipped"
  )
}

/**
 * The step the in-session driver should run next: the first non-terminal step
 * in `order` whose dependencies have all completed.
 *
 * Lives here rather than in the driver so `PlanRuntime.startPlan` and
 * `handlePlanTurnComplete` share one definition of "next" — and so it stays
 * testable without Dexie. A step whose dependency failed or was skipped is NOT
 * runnable (it stays pending and the plan runs out of work), which is how an
 * in-session plan stops instead of silently jumping the broken link.
 */
export function nextRunnableStep(steps: PlanStep[]): PlanStep | undefined {
  const byId = new Map(steps.map((s) => [s.id, s]))
  return [...steps]
    .sort((a, b) => a.order - b.order)
    .find((step) => {
      if (step.status === "completed" || step.status === "failed" || step.status === "skipped") {
        return false
      }
      return step.dependencies.every((depId) => byId.get(depId)?.status === "completed")
    })
}

/**
 * The step a finished (or failed) turn was working: the explicit cursor when
 * it still points at an in-progress step, else any in-progress step (the
 * cursor can lag a concurrent orchestrator write).
 */
export function currentInProgressStep(
  steps: PlanStep[],
  currentStepId?: string
): PlanStep | undefined {
  const cursor = currentStepId ? steps.find((s) => s.id === currentStepId) : undefined
  if (cursor?.status === "in_progress") return cursor
  return [...steps].sort((a, b) => a.order - b.order).find((s) => s.status === "in_progress")
}
