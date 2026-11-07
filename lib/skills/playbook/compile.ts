/**
 * Lower a playbook to a `VisualWorkflow` (ADR-0254 §2).
 *
 * The workflow is derived: it is regenerated whenever the playbook changes, so
 * it is written `readOnly` with a `derivedFrom` record, and a person who wants
 * to change the graph detaches a copy. Compiling is deterministic: the same
 * playbook (and the same playbooks it calls) yields the same graph, node ids
 * come from step ids, and the content hash says when a stored copy is stale.
 *
 * Mapping, one step at a time:
 *
 * - `skill:<id>` → `action.agent.turn` with the skill in scope (`skillIds`),
 *   so the run gets the skill's body and resources the way chat does. `with`
 *   keys the turn understands (`prompt`, `outputSchema`, `model`, `maxTurns`,
 *   `instructions`, `timeoutMs`, `temperature`) become params; every other
 *   key is listed under "Inputs" in the prompt. `requiresTools` turns on and
 *   requires tools.
 * - `pattern:<kind>` → `pattern.<kind>`; `squad:<template>` → `action.team.run`.
 *   Both are DORMANT until the pattern core and template launch land (plan
 *   F1b): the graph shows them, but they carry no team, so parameter
 *   validation and the synthesizer-only diagnostic stop a run. The result
 *   lists them in `dormant`, and callers offer no "run as workflow" while it
 *   is non-empty.
 * - `playbook:<id>` → the called playbook, inlined under the step's id, ending
 *   in an `io.output` node that carries its outputs. It is inlined rather than
 *   called through `flow.subworkflow` because that node runs only a deployed
 *   workflow and a derived workflow is never published. The called playbook's
 *   text feeds the content hash.
 * - `approval` → `action.approval.request`; `issue.<op>` → `action.issue.<op>`;
 *   `notify` → `action.notify.send`.
 * - `humanConfirm` puts an approval in front of the step. Downstream edges
 *   leave an approval through its `approved` handle, so a rejection skips the
 *   rest of that branch.
 * - `forEach` wraps the step in a `flow.loop` (v2) container whose body is the
 *   step; `{{steps.<id>.output}}` then reads the list of per-item results.
 *
 * References: `{{inputs.x}}` reads the run payload (`$trigger.payload.x`) at
 * the top level and is replaced by the caller's value inside an inlined
 * playbook; `{{steps.<id>.output…}}` reads the step's node through
 * `$nodes[…]`, which the `needs` edges order; `{{item}}` is `$item`. A skill
 * step's output is its reply text, or the parsed object when the step declares
 * `outputSchema`; only the latter has fields to read.
 *
 * Limits: `maxBudgetUsd` becomes the workflow's `maxCostUsd` run budget,
 * which `runWorkflow` enforces; `maxFanout` caps in-run concurrency and each loop's parallel iterations.
 * `maxSubagents` bounds pattern fan-out, which nothing in a workflow runs
 * until F1b. A called playbook's limits do not apply; the caller's do.
 *
 * A playbook with a `sensitive` input does not compile: a workflow run stores
 * its payload in run history, and a secret must not be written there. It runs
 * as a skill instead.
 */

import type {
  VisualWorkflow,
  WorkflowDerivation,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowSettings,
} from "@/types/workflow/visual"

import type { PlaybookFlow, PlaybookStep } from "./flow-schema"
import { PLAYBOOK_REFERENCE, decodePlaybookReference } from "./parse-flow"

/** Bump when the same playbook would compile to a different graph. */
export const PLAYBOOK_COMPILER_VERSION = 1

export const PLAYBOOK_TRIGGER_NODE_ID = "pb__trigger"
export const PLAYBOOK_OUTPUT_NODE_ID = "pb__output"

/** Node ceiling for one compiled playbook, inlined playbooks included. */
export const PLAYBOOK_COMPILE_MAX_NODES = 512

/** `flow.loop` v2 accepts at most this many parallel iterations. */
const LOOP_MAX_ITERATION_CONCURRENCY = 64

/** `with` keys of a `skill:` step that are `action.agent.turn` params, not prompt inputs. */
const AGENT_TURN_WITH_KEYS = [
  "prompt",
  "outputSchema",
  "model",
  "maxTurns",
  "instructions",
  "timeoutMs",
  "temperature",
] as const

const LAYOUT = { columnWidth: 360, rowHeight: 240, container: { width: 320, height: 200 } }

/** A playbook as the compiler reads it. */
export interface PlaybookSource {
  skillId: string
  name: string
  description?: string
  /** The `flow.yaml` text, hashed byte for byte. */
  flowText: string
  flow: PlaybookFlow
}

export interface CompilePlaybookOptions {
  /** A `playbook:` step's target, or `undefined` when it is not installed or its flow does not parse. */
  resolvePlaybook: (skillId: string) => PlaybookSource | undefined
  now: number
  /**
   * Settings the limits are applied over, normally the workflow defaults. The
   * caller passes them so this kernel file imports no workflow value.
   */
  settings: WorkflowSettings
}

export type PlaybookCompileProblemCode =
  | "compile_playbook_unknown"
  | "compile_playbook_cycle"
  | "compile_playbook_input_unknown"
  | "compile_playbook_input_missing"
  | "compile_playbook_for_each"
  | "compile_input_sensitive"
  | "compile_reference_unstructured"
  | "compile_too_large"

export interface PlaybookCompileProblem {
  code: PlaybookCompileProblemCode
  /** The playbook whose flow the problem is in: the one compiled, or one inlined into it. */
  skillId: string
  /** RFC 6901 pointer into that playbook's `flow.yaml`. */
  pointer: string
  message: string
}

export type PlaybookDormantReason = "pattern-core-pending" | "squad-template-pending"

/** A node the graph shows but no workflow run can execute yet (plan F1b). */
export interface PlaybookDormantNode {
  nodeId: string
  skillId: string
  stepId: string
  reason: PlaybookDormantReason
}

export type CompilePlaybookResult =
  | { ok: true; workflow: VisualWorkflow; dormant: PlaybookDormantNode[] }
  | { ok: false; problems: PlaybookCompileProblem[] }

/**
 * The derived workflow's id. Stable per skill, so recompiling overwrites the
 * same row; the hash suffix keeps two skill ids that sanitise alike apart.
 */
export function playbookWorkflowId(skillId: string): string {
  const readable = skillId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
  return `wf_playbook_${readable}_${fnv1a32(skillId)}`
}

export async function compilePlaybook(
  source: PlaybookSource,
  options: CompilePlaybookOptions
): Promise<CompilePlaybookResult> {
  const compiler = new Compiler(source, options)
  const lowered = compiler.lower()
  if (!lowered) return { ok: false, problems: compiler.problems }

  const contentHash = await sha256Hex(
    JSON.stringify({
      compilerVersion: PLAYBOOK_COMPILER_VERSION,
      playbooks: compiler.visited.map((p) => [
        p.skillId,
        p.name,
        p.description ?? null,
        p.flowText,
      ]),
    })
  )
  const derivedFrom: WorkflowDerivation = {
    kind: "playbook",
    skillId: source.skillId,
    contentHash,
    compilerVersion: PLAYBOOK_COMPILER_VERSION,
    compiledAt: options.now,
  }
  const workflow: VisualWorkflow = {
    id: playbookWorkflowId(source.skillId),
    schemaVersion: 2,
    name: source.name,
    ...(source.description ? { description: source.description } : {}),
    tags: ["playbook"],
    isTemplate: false,
    isBuiltIn: false,
    createdAt: options.now,
    updatedAt: options.now,
    nodes: lowered.nodes,
    edges: lowered.edges,
    settings: compiler.settings(),
    viewport: { x: 0, y: 0, zoom: 1 },
    interface: { inputSchema: lowered.inputSchema },
    derivedFrom,
    readOnly: true,
  }
  return { ok: true, workflow, dormant: compiler.dormant }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/** Where edges into a node come from; an approval is left through `approved`. */
interface Exit {
  nodeId: string
  handle?: "approved"
}

/** How `{{steps.<id>.output…}}` reads a step. */
interface StepRoot {
  /** Expression without braces, e.g. `$nodes['pb_a'].text`. */
  expr: string
  /** Whether the output has fields to read: false for a skill step's plain reply text. */
  structured: boolean
}

type InputBinding = { kind: "trigger" } | { kind: "values"; values: Map<string, unknown> }

interface Frame {
  source: PlaybookSource
  /** Node id prefix: `pb_` at the top, `pb_<step>__` inside an inlined playbook. */
  prefix: string
  inputs: InputBinding
  /** Where a step with no `needs` is entered from. */
  entry: Exit[]
  /** Skill ids being inlined, outermost first, for cycle detection. */
  stack: string[]
}

interface Scope {
  frame: Frame
  roots: ReadonlyMap<string, StepRoot>
  pointer: string
}

class Compiler {
  readonly problems: PlaybookCompileProblem[] = []
  readonly dormant: PlaybookDormantNode[] = []
  /** The compiled playbook, then each inlined one in first-visit order. */
  readonly visited: PlaybookSource[] = []
  private readonly nodes: WorkflowNode[] = []
  private readonly edges: WorkflowEdge[] = []
  private readonly edgeIds = new Set<string>()

  constructor(
    private readonly root: PlaybookSource,
    private readonly options: CompilePlaybookOptions
  ) {}

  lower():
    | { nodes: WorkflowNode[]; edges: WorkflowEdge[]; inputSchema: Record<string, unknown> }
    | undefined {
    const { flow, skillId } = this.root
    flow.inputs.forEach((input, index) => {
      if (input.kind === "sensitive") {
        this.problem(
          "compile_input_sensitive",
          skillId,
          `/inputs/${index}/kind`,
          `input "${input.name}" is sensitive; a workflow run stores its inputs in run history, so run this playbook as a skill`
        )
      }
    })

    const inputSchema = triggerInputSchema(flow)
    this.addNode({
      id: PLAYBOOK_TRIGGER_NODE_ID,
      type: "trigger.manual",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Start", params: { inputSchema } },
    })

    const frame: Frame = {
      source: this.root,
      prefix: "pb_",
      inputs: { kind: "trigger" },
      entry: [{ nodeId: PLAYBOOK_TRIGGER_NODE_ID }],
      stack: [skillId],
    }
    const result = this.lowerFlow(frame)
    if (result && Object.keys(flow.outputs).length > 0) {
      this.addNode({
        id: PLAYBOOK_OUTPUT_NODE_ID,
        type: "io.output",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: {
          label: "Result",
          params: { value: this.translateOutputs(frame, result.roots) },
        },
      })
      for (const exit of result.sinks) this.addEdge(exit, PLAYBOOK_OUTPUT_NODE_ID)
    }

    if (this.nodes.length > PLAYBOOK_COMPILE_MAX_NODES) {
      this.problem(
        "compile_too_large",
        skillId,
        "",
        `the compiled workflow has ${this.nodes.length} nodes; the limit is ${PLAYBOOK_COMPILE_MAX_NODES}`
      )
    }
    if (this.problems.length > 0) return undefined
    layout(this.nodes, this.edges)
    return { nodes: this.nodes, edges: this.edges, inputSchema }
  }

  settings(): WorkflowSettings {
    const base = this.options.settings
    const { maxBudgetUsd, maxFanout } = this.root.flow.limits
    return {
      ...structuredClone(base),
      riskGating: base.riskGating ?? true,
      ...(maxBudgetUsd !== undefined ? { maxCostUsd: maxBudgetUsd } : {}),
      ...(maxFanout !== undefined
        ? { maxConcurrency: Math.min(base.maxConcurrency ?? maxFanout, maxFanout) }
        : {}),
    }
  }

  /** Lower one flow's steps. Returns `undefined` when a problem stops it. */
  private lowerFlow(
    frame: Frame
  ): { sinks: Exit[]; roots: ReadonlyMap<string, StepRoot> } | undefined {
    if (!this.visited.some((p) => p.skillId === frame.source.skillId)) {
      this.visited.push(frame.source)
    }
    const { steps } = frame.source.flow
    const exits = new Map<string, Exit>()
    const roots = new Map<string, StepRoot>()
    let failed = false

    for (const index of topologicalOrder(steps)) {
      const step = steps[index]
      const pointer = `/steps/${index}`
      const preds = step.needs.length > 0 ? step.needs.map((need) => exits.get(need)) : frame.entry
      // A step after one that failed to lower is skipped; its problem is reported already.
      if (preds.some((pred) => pred === undefined)) {
        failed = true
        continue
      }
      const scope: Scope = { frame, roots, pointer }
      const lowered = this.lowerStep(step, preds as Exit[], scope)
      if (!lowered) {
        failed = true
        continue
      }
      exits.set(step.id, lowered.exit)
      roots.set(step.id, lowered.root)
    }
    if (failed) return undefined

    const needed = new Set(steps.flatMap((step) => step.needs))
    const sinks = steps.filter((step) => !needed.has(step.id)).map((step) => exits.get(step.id)!)
    return { sinks, roots }
  }

  private lowerStep(
    step: PlaybookStep,
    preds: Exit[],
    scope: Scope
  ): { exit: Exit; root: StepRoot } | undefined {
    const nodeId = scope.frame.prefix + step.id
    const skillId = scope.frame.source.skillId

    if (step.use.kind === "playbook" && step.forEach !== undefined) {
      this.problem(
        "compile_playbook_for_each",
        skillId,
        `${scope.pointer}/forEach`,
        `step "${step.id}" runs a playbook for each item; a workflow cannot loop over an inlined playbook, so split it into a skill step`
      )
      return undefined
    }

    let entry = preds
    if (step.humanConfirm) {
      const confirmId = `${nodeId}__confirm`
      this.addNode({
        id: confirmId,
        type: "action.approval.request",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: {
          label: `Confirm ${step.id}`,
          params: {
            title: `Confirm "${step.id}"`,
            message: `Approve to run step "${step.id}" of the playbook "${scope.frame.source.name}".`,
          },
        },
      })
      for (const pred of preds) this.addEdge(pred, confirmId)
      entry = [{ nodeId: confirmId, handle: "approved" }]
    }

    if (step.use.kind === "playbook") return this.inlinePlaybook(step, entry, scope)

    const inLoop = step.forEach !== undefined
    const body = this.stepNode(step, scope, inLoop)
    if (!body) return undefined
    const dormantReason: PlaybookDormantReason | undefined =
      step.use.kind === "pattern"
        ? "pattern-core-pending"
        : step.use.kind === "squad"
          ? "squad-template-pending"
          : undefined
    const exitHandle = step.use.kind === "approval" ? ("approved" as const) : undefined

    if (!inLoop) {
      this.addNode({ id: nodeId, ...body.node, position: { x: 0, y: 0 } })
      for (const pred of entry) this.addEdge(pred, nodeId)
      if (dormantReason) this.markDormant(nodeId, skillId, step.id, dormantReason)
      return {
        exit: { nodeId, ...(exitHandle ? { handle: exitHandle } : {}) },
        root: { expr: `$nodes['${nodeId}']${body.suffix}`, structured: body.structured },
      }
    }

    const bodyId = `${nodeId}__body`
    const maxFanout = this.root.flow.limits.maxFanout
    this.addNode({
      id: nodeId,
      type: "flow.loop",
      typeVersion: 2,
      position: { x: 0, y: 0 },
      width: LAYOUT.container.width,
      height: LAYOUT.container.height,
      data: {
        label: step.id,
        params: {
          mode: "forEach",
          source: this.translate(step.forEach, { ...scope, pointer: `${scope.pointer}/forEach` }),
          output: `{{ $node['${bodyId}']${body.suffix} }}`,
          ...(maxFanout !== undefined
            ? { iterationConcurrency: Math.min(maxFanout, LOOP_MAX_ITERATION_CONCURRENCY) }
            : {}),
        },
      },
    })
    this.addNode({
      id: bodyId,
      ...body.node,
      parentId: nodeId,
      position: { x: 40, y: 70 },
    })
    for (const pred of entry) this.addEdge(pred, nodeId)
    if (dormantReason) this.markDormant(bodyId, skillId, step.id, dormantReason)
    return {
      exit: { nodeId },
      root: { expr: `$nodes['${nodeId}'].items`, structured: true },
    }
  }

  /** The node a non-playbook step runs, without id or position. */
  private stepNode(
    step: PlaybookStep,
    scope: Scope,
    inLoop: boolean
  ):
    | {
        node: Pick<WorkflowNode, "type" | "typeVersion" | "data">
        suffix: string
        structured: boolean
      }
    | undefined {
    const withPointer = `${scope.pointer}/with`
    const translated = this.translate(step.with, { ...scope, pointer: withPointer }) as Record<
      string,
      unknown
    >
    const node = (type: string, params: Record<string, unknown>, label = step.id) => ({
      type: type as WorkflowNodeKind,
      typeVersion: 1,
      data: { label: inLoop ? `${label} (each)` : label, params },
    })

    switch (step.use.kind) {
      case "skill": {
        const params: Record<string, unknown> = {
          prompt: skillPrompt(step.use.skillId, translated),
          skillIds: [step.use.skillId],
        }
        for (const key of AGENT_TURN_WITH_KEYS) {
          if (key !== "prompt" && translated[key] !== undefined) params[key] = translated[key]
        }
        if (step.requiresTools) {
          params.toolsEnabled = true
          params.requireTools = true
        }
        const structured = step.with.outputSchema !== undefined
        return {
          node: node("action.agent.turn", params),
          suffix: structured ? ".object" : ".text",
          structured,
        }
      }
      case "pattern":
        return {
          node: node(`pattern.${step.use.pattern}`, {
            ...translated,
            objective: translated.objective ?? `${scope.frame.source.name}: ${step.id}`,
          }),
          suffix: "",
          structured: true,
        }
      case "squad":
        return {
          node: node("action.team.run", {
            ...translated,
            templateId: step.use.templateId,
            goal: translated.goal ?? `${scope.frame.source.name}: ${step.id}`,
          }),
          suffix: "",
          structured: true,
        }
      case "approval":
        return {
          node: node("action.approval.request", {
            ...translated,
            title: translated.title ?? step.id,
          }),
          suffix: "",
          structured: true,
        }
      case "issue":
        return {
          node: node(`action.issue.${step.use.operation}`, translated),
          suffix: "",
          structured: true,
        }
      case "notify":
        return {
          node: node("action.notify.send", { ...translated, title: translated.title ?? step.id }),
          suffix: "",
          structured: true,
        }
      case "playbook":
        return undefined
    }
  }

  private inlinePlaybook(
    step: PlaybookStep,
    entry: Exit[],
    scope: Scope
  ): { exit: Exit; root: StepRoot } | undefined {
    if (step.use.kind !== "playbook") return undefined
    const caller = scope.frame.source.skillId
    const calleeId = step.use.skillId
    const usesPointer = `${scope.pointer}/uses`

    if (scope.frame.stack.includes(calleeId)) {
      this.problem(
        "compile_playbook_cycle",
        caller,
        usesPointer,
        `playbooks call each other in a cycle: ${[...scope.frame.stack, calleeId].join(" → ")}`
      )
      return undefined
    }
    const callee = this.options.resolvePlaybook(calleeId)
    if (!callee) {
      this.problem(
        "compile_playbook_unknown",
        caller,
        usesPointer,
        `step "${step.id}" calls playbook "${calleeId}", which is not installed or has no valid flow.yaml`
      )
      return undefined
    }

    const declared = new Set(callee.flow.inputs.map((input) => input.name))
    let bindingFailed = false
    for (const key of Object.keys(step.with)) {
      if (!declared.has(key)) {
        this.problem(
          "compile_playbook_input_unknown",
          caller,
          `${scope.pointer}/with/${escapePointer(key)}`,
          `playbook "${calleeId}" has no input "${key}"`
        )
        bindingFailed = true
      }
    }
    const values = new Map<string, unknown>()
    for (const input of callee.flow.inputs) {
      if (Object.hasOwn(step.with, input.name)) {
        values.set(
          input.name,
          this.translate(step.with[input.name], {
            ...scope,
            pointer: `${scope.pointer}/with/${escapePointer(input.name)}`,
          })
        )
      } else if (input.default !== undefined) {
        values.set(input.name, input.default)
      } else if (input.required) {
        this.problem(
          "compile_playbook_input_missing",
          caller,
          `${scope.pointer}/with`,
          `step "${step.id}" does not pass the required input "${input.name}" to playbook "${calleeId}"`
        )
        bindingFailed = true
      }
    }
    if (bindingFailed) return undefined

    const nodeId = scope.frame.prefix + step.id
    const frame: Frame = {
      source: callee,
      prefix: `${nodeId}__`,
      inputs: { kind: "values", values },
      entry,
      stack: [...scope.frame.stack, calleeId],
    }
    const result = this.lowerFlow(frame)
    if (!result) return undefined

    this.addNode({
      id: nodeId,
      type: "io.output",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: {
        label: step.id,
        params: { value: this.translateOutputs(frame, result.roots) },
      },
    })
    for (const sink of result.sinks) this.addEdge(sink, nodeId)
    return {
      exit: { nodeId },
      root: { expr: `$nodes['${nodeId}'].value`, structured: true },
    }
  }

  private translateOutputs(frame: Frame, roots: ReadonlyMap<string, StepRoot>) {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(frame.source.flow.outputs)) {
      out[name] = this.translate(value, {
        frame,
        roots,
        pointer: `/outputs/${escapePointer(name)}`,
      })
    }
    return out
  }

  /** Rewrite every playbook reference in a `with` value into workflow expressions. */
  private translate(value: unknown, scope: Scope): unknown {
    if (typeof value === "string") return this.translateString(value, scope)
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.translate(item, { ...scope, pointer: `${scope.pointer}/${index}` })
      )
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        out[key] = this.translate(item, {
          ...scope,
          pointer: `${scope.pointer}/${escapePointer(key)}`,
        })
      }
      return out
    }
    return value
  }

  private translateString(text: string, scope: Scope): unknown {
    // A string that is exactly one reference keeps the referenced value's
    // type, the way the workflow resolver treats a lone `{{ … }}`.
    const whole = /^\{\{([^{}]*)\}\}$/.exec(text)
    if (whole) return this.translateReference(whole[1].trim(), scope, true)
    return text.replace(new RegExp(PLAYBOOK_REFERENCE.source, "g"), (match, inner: string) => {
      const translated = this.translateReference(inner.trim(), scope, false)
      return translated === undefined ? match : (translated as string)
    })
  }

  /**
   * One reference. `whole` = the string is just this reference, so an inlined
   * input may be substituted with its typed value; otherwise the result is
   * text to splice in.
   */
  private translateReference(text: string, scope: Scope, whole: boolean): unknown {
    const reference = decodePlaybookReference(text)
    // The parser has already refused anything that does not decode.
    if (!reference) return whole ? `{{${text}}}` : undefined
    switch (reference.kind) {
      case "item":
        return "{{ $item }}"
      case "input": {
        const { inputs } = scope.frame
        if (inputs.kind === "trigger") return `{{ $trigger.payload${accessor([reference.name])} }}`
        const value = inputs.values.get(reference.name)
        return whole ? value : spliceText(value)
      }
      case "step": {
        const root = scope.roots.get(reference.stepId)
        // Missing only when that step failed to lower and reported why.
        if (!root) return whole ? `{{${text}}}` : undefined
        if (reference.path.length > 0 && !root.structured) {
          this.problem(
            "compile_reference_unstructured",
            scope.frame.source.skillId,
            scope.pointer,
            `{{${text}}} reads a field, but step "${reference.stepId}" replies with plain text; give it an outputSchema`
          )
        }
        return `{{ ${root.expr}${accessor(reference.path)} }}`
      }
    }
  }

  private markDormant(
    nodeId: string,
    skillId: string,
    stepId: string,
    reason: PlaybookDormantReason
  ) {
    this.dormant.push({ nodeId, skillId, stepId, reason })
  }

  private problem(
    code: PlaybookCompileProblemCode,
    skillId: string,
    pointer: string,
    message: string
  ): void {
    this.problems.push({ code, skillId, pointer, message })
  }

  private addNode(node: WorkflowNode): void {
    this.nodes.push(node)
  }

  private addEdge(from: Exit, target: string): void {
    const id = `e_${from.nodeId}${from.handle ? `__${from.handle}` : ""}__${target}`
    if (this.edgeIds.has(id)) return
    this.edgeIds.add(id)
    this.edges.push({
      id,
      source: from.nodeId,
      target,
      ...(from.handle ? { sourceHandle: from.handle } : {}),
    })
  }
}

function triggerInputSchema(flow: PlaybookFlow): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const input of flow.inputs) {
    properties[input.name] = {
      type: "string",
      ...(input.description ? { description: input.description } : {}),
      ...(input.default !== undefined ? { default: input.default } : {}),
    }
    // An input with a default is required too: nothing in a workflow run
    // fills a schema default in, so whoever starts the run must send it (the
    // run form and the playbook launcher prefill it from `default`).
    if (input.required || input.default !== undefined) required.push(input.name)
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) }
}

/** The prompt a `skill:` step sends: its `prompt`, then every other `with` key as an input. */
function skillPrompt(skillId: string, translated: Record<string, unknown>): string {
  const lead =
    translated.prompt === undefined ? `Run the "${skillId}" skill.` : spliceText(translated.prompt)
  const inputs = Object.entries(translated).filter(
    ([key]) => !(AGENT_TURN_WITH_KEYS as readonly string[]).includes(key)
  )
  if (inputs.length === 0) return lead
  return [
    lead,
    "",
    "Inputs:",
    ...inputs.map(([key, value]) => `- ${key}: ${spliceText(value)}`),
  ].join("\n")
}

/** How the workflow resolver renders a value spliced into text. */
function spliceText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/** Expression accessors for a reference path. */
function accessor(path: readonly string[]): string {
  return path
    .map((segment) => {
      if (/^\d+$/.test(segment)) return `[${segment}]`
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) return `.${segment}`
      return `['${segment}']`
    })
    .join("")
}

function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1")
}

/** Step indexes in dependency order; ties keep file order. The parser has refused cycles. */
function topologicalOrder(steps: readonly PlaybookStep[]): number[] {
  const index = new Map(steps.map((step, i) => [step.id, i]))
  const remaining = steps.map((step) => new Set(step.needs))
  const done = new Set<string>()
  const order: number[] = []
  while (order.length < steps.length) {
    const next = steps.findIndex(
      (step, i) => !done.has(step.id) && [...remaining[i]].every((need) => done.has(need))
    )
    if (next === -1) break
    done.add(steps[next].id)
    order.push(next)
  }
  // A cycle would leave steps behind; keep them so nothing is silently dropped.
  for (const step of steps) if (!done.has(step.id)) order.push(index.get(step.id)!)
  return order
}

/** Place top-level nodes in columns by longest path from the trigger. */
function layout(nodes: WorkflowNode[], edges: readonly WorkflowEdge[]): void {
  const topLevel = nodes.filter((node) => node.parentId === undefined)
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
  }
  const column = new Map<string, number>()
  const columnOf = (id: string, seen: Set<string>): number => {
    const known = column.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    const preds = incoming.get(id) ?? []
    const value = preds.length === 0 ? 0 : Math.max(...preds.map((p) => columnOf(p, seen))) + 1
    column.set(id, value)
    return value
  }
  const rows = new Map<number, number>()
  for (const node of topLevel) {
    const x = columnOf(node.id, new Set())
    const row = rows.get(x) ?? 0
    rows.set(x, row + 1)
    node.position = { x: x * LAYOUT.columnWidth, y: row * LAYOUT.rowHeight }
  }
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
