/**
 * Keep a playbook's derived workflow in step with the playbook (ADR-0254 §2).
 *
 * A playbook is a skill with a `references/flow.yaml`. "Open as workflow"
 * asks for its workflow here: the flow is read the way a skill run reads it,
 * compiled, and written through the one path that may write a read-only row,
 * but only when the content hash (or the compiler) changed. A playbook that
 * calls other playbooks loads them first, since compiling inlines them.
 *
 * Nothing here runs the workflow. A result with `dormant` nodes still opens,
 * read-only, but the caller must not offer to run it (plan F1b).
 */

import type { Skill, SkillResource } from "@cognia/agent-config-types"

import { getSkill } from "@/lib/db/skills"
import { getWorkflow, putDerivedWorkflow } from "@/lib/db/workflows"
import {
  compilePlaybook,
  playbookWorkflowId,
  PLAYBOOK_COMPILER_VERSION,
  type PlaybookCompileProblem,
  type PlaybookDormantNode,
  type PlaybookSource,
} from "@/lib/skills/playbook/compile"
import {
  findPlaybookFlowText,
  parsePlaybookFlow,
  type PlaybookFlowProblem,
} from "@/lib/skills/playbook/parse-flow"
import { listRuntimeResources } from "@/lib/skills/runtime-loader"
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

/** Most playbooks one compile may load, the compiled one included. Guards a runaway call graph. */
export const MAX_PLAYBOOKS_PER_COMPILE = 32

export interface PlaybookWorkflowDeps {
  getSkill(id: string): Promise<Pick<Skill, "id" | "name" | "description"> | undefined>
  listResources(skillId: string): Promise<SkillResource[]>
  getWorkflow(id: string): Promise<VisualWorkflow | undefined>
  putDerivedWorkflow(workflow: VisualWorkflow): Promise<VisualWorkflow>
  now(): number
}

const defaultDeps: PlaybookWorkflowDeps = {
  getSkill,
  listResources: listRuntimeResources,
  getWorkflow,
  putDerivedWorkflow,
  now: () => Date.now(),
}

export type PlaybookSourceResult =
  | { status: "ok"; source: PlaybookSource }
  | { status: "missing" }
  | { status: "not-a-playbook" }
  | { status: "invalid"; problems: PlaybookFlowProblem[] }

/** A skill as a playbook: its flow parsed, or why it is not one. */
export async function loadPlaybookSource(
  skillId: string,
  deps: Pick<PlaybookWorkflowDeps, "getSkill" | "listResources"> = defaultDeps
): Promise<PlaybookSourceResult> {
  const skill = await deps.getSkill(skillId)
  if (!skill) return { status: "missing" }
  const flowText = findPlaybookFlowText(await deps.listResources(skillId))
  if (flowText === undefined) return { status: "not-a-playbook" }
  const parsed = parsePlaybookFlow(flowText)
  if (!parsed.ok) return { status: "invalid", problems: parsed.problems }
  return {
    status: "ok",
    source: {
      skillId,
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      flowText,
      flow: parsed.flow,
    },
  }
}

export type PlaybookWorkflowResult =
  | {
      status: "current" | "compiled"
      workflow: VisualWorkflow
      /** Steps shown but not runnable yet; offer no run while non-empty. */
      dormant: PlaybookDormantNode[]
    }
  | { status: "missing" }
  | { status: "not-a-playbook" }
  | { status: "invalid"; problems: PlaybookFlowProblem[] }
  | { status: "uncompilable"; problems: PlaybookCompileProblem[] }
  | { status: "too-many-playbooks"; limit: number }

/**
 * The playbook's derived workflow, compiled and stored when the stored copy
 * is missing or stale. `current` = the stored row already matched.
 */
export async function syncPlaybookWorkflow(
  skillId: string,
  deps: PlaybookWorkflowDeps = defaultDeps
): Promise<PlaybookWorkflowResult> {
  const root = await loadPlaybookSource(skillId, deps)
  if (root.status !== "ok") return root

  const library = await loadCalledPlaybooks(root.source, deps)
  if (!library) return { status: "too-many-playbooks", limit: MAX_PLAYBOOKS_PER_COMPILE }

  const compiled = await compilePlaybook(root.source, {
    now: deps.now(),
    settings: DEFAULT_WORKFLOW_SETTINGS,
    resolvePlaybook: (id) => library.get(id),
  })
  if (!compiled.ok) return { status: "uncompilable", problems: compiled.problems }

  const stored = await deps.getWorkflow(playbookWorkflowId(skillId))
  if (
    stored?.derivedFrom &&
    stored.derivedFrom.compilerVersion === PLAYBOOK_COMPILER_VERSION &&
    stored.derivedFrom.contentHash === compiled.workflow.derivedFrom?.contentHash
  ) {
    return { status: "current", workflow: stored, dormant: compiled.dormant }
  }
  const workflow = await deps.putDerivedWorkflow(compiled.workflow)
  return { status: "compiled", workflow, dormant: compiled.dormant }
}

/**
 * Every playbook reachable through `playbook:` steps, loaded up front because
 * the compiler resolves them synchronously. One that is missing or does not
 * parse is left out; the compiler reports the step that calls it. `undefined`
 * when the call graph passes {@link MAX_PLAYBOOKS_PER_COMPILE}.
 */
async function loadCalledPlaybooks(
  root: PlaybookSource,
  deps: Pick<PlaybookWorkflowDeps, "getSkill" | "listResources">
): Promise<Map<string, PlaybookSource> | undefined> {
  const library = new Map<string, PlaybookSource>([[root.skillId, root]])
  const seen = new Set([root.skillId])
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const step of current.flow.steps) {
      if (step.use.kind !== "playbook" || seen.has(step.use.skillId)) continue
      seen.add(step.use.skillId)
      if (seen.size > MAX_PLAYBOOKS_PER_COMPILE) return undefined
      const loaded = await loadPlaybookSource(step.use.skillId, deps)
      if (loaded.status !== "ok") continue
      library.set(loaded.source.skillId, loaded.source)
      queue.push(loaded.source)
    }
  }
  return library
}
