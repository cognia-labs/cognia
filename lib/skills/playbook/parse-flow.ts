/**
 * Read a playbook's `references/flow.yaml` (ADR-0254 §1).
 *
 * Read the way the review policy is read (`lib/scm/review/review-policy.ts`):
 * closed-world, every problem addressed by an RFC 6901 pointer, all problems
 * reported at once rather than the first one. On top of the schema it checks
 * what a schema cannot:
 *
 * - step ids and input names are unique;
 * - `uses` names something this version knows;
 * - `needs` names existing steps and forms no cycle;
 * - every `{{…}}` reference resolves: `inputs.<name>` to a declared input,
 *   `steps.<id>…` inside a step to one of its ancestors (a step can only read
 *   output that exists when it runs), `item` only inside a `forEach` step;
 * - a `sensitive` input carries no default, so no secret is written into the
 *   skill.
 *
 * Duplicate YAML keys are refused (a silently kept last value is how a reviewed
 * file differs from the one that runs), and YAML aliases are refused (they add
 * nothing a flow needs and let a small file expand into a large one).
 */

import { parseDocument } from "yaml"
import type { z } from "zod"

import { jsonPointer } from "@/lib/project-environment/workspace-config"
import type { SkillResource } from "@cognia/agent-config-types"

import {
  PLAYBOOK_FLOW_LIMITS,
  PLAYBOOK_FLOW_PATH,
  decodeStepUse,
  playbookFlowSchema,
  type PlaybookFlow,
  type PlaybookStep,
} from "./flow-schema"

export type PlaybookFlowProblemCode =
  | "flow_too_large"
  | "flow_yaml_invalid"
  | "flow_key_duplicate"
  | "flow_alias_unsupported"
  | "flow_version_unsupported"
  | "flow_field_unknown"
  | "flow_field_invalid"
  | "flow_input_duplicate"
  | "flow_input_sensitive_default"
  | "flow_step_duplicate"
  | "flow_step_uses_unknown"
  | "flow_step_needs_unknown"
  | "flow_step_needs_cycle"
  | "flow_reference_invalid"
  | "flow_reference_input_unknown"
  | "flow_reference_step_unknown"
  | "flow_reference_step_not_ancestor"
  | "flow_reference_item_outside_for_each"

export interface PlaybookFlowProblem {
  code: PlaybookFlowProblemCode
  pointer: string
  message: string
}

export type PlaybookFlowParseResult =
  { ok: true; flow: PlaybookFlow } | { ok: false; problems: PlaybookFlowProblem[] }

/**
 * The text of a skill's `references/flow.yaml`, or `undefined` when the skill
 * has none. A binary (base64) resource at that path is not a flow.
 */
export function findPlaybookFlowText(
  resources: ReadonlyArray<Pick<SkillResource, "path" | "content" | "encoding">>
): string | undefined {
  const resource = resources.find((r) => r.path === PLAYBOOK_FLOW_PATH)
  if (!resource || resource.encoding === "base64") return undefined
  return resource.content
}

/** Parse and validate a `flow.yaml` document. */
export function parsePlaybookFlow(text: string): PlaybookFlowParseResult {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > PLAYBOOK_FLOW_LIMITS.maxBytes) {
    return fail({
      code: "flow_too_large",
      pointer: "",
      message: `flow.yaml is ${bytes} bytes; the limit is ${PLAYBOOK_FLOW_LIMITS.maxBytes}`,
    })
  }

  const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false })
  if (document.errors.length > 0) {
    return {
      ok: false,
      problems: document.errors.map((error) => ({
        code: error.code === "DUPLICATE_KEY" ? "flow_key_duplicate" : "flow_yaml_invalid",
        pointer: "",
        message: error.message,
      })),
    }
  }

  let raw: unknown
  try {
    raw = document.toJS({ maxAliasCount: 0 })
  } catch {
    return fail({
      code: "flow_alias_unsupported",
      pointer: "",
      message: "YAML aliases are not supported in flow.yaml",
    })
  }

  const parsed = playbookFlowSchema.safeParse(raw)
  if (!parsed.success) {
    // Zod's issue order is not part of its contract; sort so a report is stable.
    const schema = parsed.error.issues.flatMap(schemaProblems)
    schema.sort((a, b) => a.pointer.localeCompare(b.pointer) || a.code.localeCompare(b.code))
    return { ok: false, problems: schema }
  }

  const problems: PlaybookFlowProblem[] = []
  const inputs = parsed.data.inputs
  const inputNames = new Set<string>()
  inputs.forEach((input, index) => {
    const pointer = jsonPointer("/inputs", index)
    if (inputNames.has(input.name)) {
      problems.push({
        code: "flow_input_duplicate",
        pointer: jsonPointer(pointer, "name"),
        message: `input "${input.name}" is declared more than once`,
      })
    }
    inputNames.add(input.name)
    if (input.kind === "sensitive" && input.default !== undefined) {
      problems.push({
        code: "flow_input_sensitive_default",
        pointer: jsonPointer(pointer, "default"),
        message: `sensitive input "${input.name}" cannot have a default; it would be stored in the skill`,
      })
    }
  })

  const steps: PlaybookStep[] = []
  const stepIndex = new Map<string, number>()
  parsed.data.steps.forEach((step, index) => {
    const pointer = jsonPointer("/steps", index)
    if (stepIndex.has(step.id)) {
      problems.push({
        code: "flow_step_duplicate",
        pointer: jsonPointer(pointer, "id"),
        message: `step id "${step.id}" is used more than once`,
      })
    } else {
      stepIndex.set(step.id, index)
    }
    const use = decodeStepUse(step.uses)
    if (!use) {
      problems.push({
        code: "flow_step_uses_unknown",
        pointer: jsonPointer(pointer, "uses"),
        message: `"${step.uses}" is not a known step kind (skill:, pattern:, squad:, playbook:, approval, issue.<op>, notify)`,
      })
    }
    step.needs.forEach((need, needIndex) => {
      if (!parsed.data.steps.some((other) => other.id === need)) {
        problems.push({
          code: "flow_step_needs_unknown",
          pointer: jsonPointer(pointer, "needs", needIndex),
          message: `step "${step.id}" needs "${need}", which is not a step`,
        })
      }
    })
    if (use) steps.push({ ...step, use })
  })

  problems.push(...cycleProblems(parsed.data.steps, stepIndex))

  const ancestors = ancestorSets(parsed.data.steps)
  parsed.data.steps.forEach((step, index) => {
    const pointer = jsonPointer("/steps", index)
    const scope: ReferenceScope = {
      inputs: inputNames,
      steps: stepIndex,
      ancestors: ancestors.get(step.id) ?? new Set(),
      allowItem: step.forEach !== undefined,
      stepId: step.id,
    }
    if (step.forEach !== undefined) {
      checkReferences(
        step.forEach,
        jsonPointer(pointer, "forEach"),
        { ...scope, allowItem: false },
        problems
      )
    }
    walkStrings(step.with, jsonPointer(pointer, "with"), (value, at) =>
      checkReferences(value, at, scope, problems)
    )
  })
  for (const [name, value] of Object.entries(parsed.data.outputs)) {
    checkReferences(
      value,
      jsonPointer("/outputs", name),
      { inputs: inputNames, steps: stepIndex, ancestors: null, allowItem: false, stepId: null },
      problems
    )
  }

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    flow: {
      version: parsed.data.version,
      inputs,
      steps,
      limits: parsed.data.limits,
      outputs: parsed.data.outputs,
    },
  }
}

function fail(problem: PlaybookFlowProblem): PlaybookFlowParseResult {
  return { ok: false, problems: [problem] }
}

function schemaProblems(issue: z.core.$ZodIssue): PlaybookFlowProblem[] {
  const path = issue.path.map((segment) =>
    typeof segment === "symbol" ? String(segment) : segment
  )
  const pointer = jsonPointer("", ...path)
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      code: "flow_field_unknown" as const,
      pointer: jsonPointer(pointer, key),
      message: `unknown field "${key}"`,
    }))
  }
  if (pointer === "/version") {
    return [
      {
        code: "flow_version_unsupported",
        pointer,
        message: "flow.yaml must declare version: 1",
      },
    ]
  }
  return [{ code: "flow_field_invalid", pointer, message: issue.message }]
}

/** One problem per cycle, at the `needs` of the step where the cycle is found. */
function cycleProblems(
  steps: ReadonlyArray<{ id: string; needs: string[] }>,
  stepIndex: ReadonlyMap<string, number>
): PlaybookFlowProblem[] {
  const needsOf = new Map(steps.map((step) => [step.id, step.needs]))
  const state = new Map<string, "visiting" | "done">()
  const problems: PlaybookFlowProblem[] = []
  const visit = (id: string, path: string[]): void => {
    state.set(id, "visiting")
    for (const need of needsOf.get(id) ?? []) {
      if (!needsOf.has(need)) continue
      const seen = state.get(need)
      if (seen === "visiting") {
        const cycle = [...path.slice(path.indexOf(need)), need]
        problems.push({
          code: "flow_step_needs_cycle",
          pointer: jsonPointer("/steps", stepIndex.get(id) ?? 0, "needs"),
          message: `steps form a cycle: ${cycle.join(" → ")}`,
        })
      } else if (seen === undefined) {
        visit(need, [...path, need])
      }
    }
    state.set(id, "done")
  }
  for (const step of steps) {
    if (!state.has(step.id)) visit(step.id, [step.id])
  }
  return problems
}

/** Every step's transitive `needs`. Cycles are reported elsewhere and simply stop the walk. */
function ancestorSets(
  steps: ReadonlyArray<{ id: string; needs: string[] }>
): Map<string, Set<string>> {
  const needsOf = new Map(steps.map((step) => [step.id, step.needs]))
  const result = new Map<string, Set<string>>()
  for (const step of steps) {
    const seen = new Set<string>()
    const stack = [...step.needs]
    while (stack.length > 0) {
      const next = stack.pop()!
      if (seen.has(next) || next === step.id) continue
      seen.add(next)
      stack.push(...(needsOf.get(next) ?? []))
    }
    result.set(step.id, seen)
  }
  return result
}

interface ReferenceScope {
  inputs: ReadonlySet<string>
  steps: ReadonlyMap<string, number>
  /** `null` outside a step (outputs), where any step may be read. */
  ancestors: ReadonlySet<string> | null
  allowItem: boolean
  stepId: string | null
}

const REFERENCE = /\{\{([^{}]*)\}\}/g
const STEP_REFERENCE = /^steps\.([a-z][a-z0-9-]*)(?:\.[A-Za-z0-9_-]+)*$/
const INPUT_REFERENCE = /^inputs\.([A-Za-z_][A-Za-z0-9_]*)$/

function checkReferences(
  value: string,
  pointer: string,
  scope: ReferenceScope,
  problems: PlaybookFlowProblem[]
): void {
  for (const match of value.matchAll(REFERENCE)) {
    const reference = match[1].trim()
    if (reference === "item") {
      if (!scope.allowItem) {
        problems.push({
          code: "flow_reference_item_outside_for_each",
          pointer,
          message: "{{item}} is only available in a step with forEach",
        })
      }
      continue
    }
    const input = INPUT_REFERENCE.exec(reference)
    if (input) {
      if (!scope.inputs.has(input[1])) {
        problems.push({
          code: "flow_reference_input_unknown",
          pointer,
          message: `{{${reference}}} names an input that is not declared`,
        })
      }
      continue
    }
    const step = STEP_REFERENCE.exec(reference)
    if (step) {
      const target = step[1]
      if (!scope.steps.has(target)) {
        problems.push({
          code: "flow_reference_step_unknown",
          pointer,
          message: `{{${reference}}} names step "${target}", which does not exist`,
        })
      } else if (scope.ancestors && !scope.ancestors.has(target)) {
        problems.push({
          code: "flow_reference_step_not_ancestor",
          pointer,
          message: `step "${scope.stepId}" reads "${target}" but does not need it, directly or through another step`,
        })
      }
      continue
    }
    problems.push({
      code: "flow_reference_invalid",
      pointer,
      message: `{{${reference}}} is not inputs.<name>, steps.<id>… or item`,
    })
  }
}

function walkStrings(
  value: unknown,
  pointer: string,
  visit: (value: string, pointer: string) => void
): void {
  if (typeof value === "string") {
    visit(value, pointer)
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, jsonPointer(pointer, index), visit))
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      walkStrings(item, jsonPointer(pointer, key), visit)
    }
  }
}
