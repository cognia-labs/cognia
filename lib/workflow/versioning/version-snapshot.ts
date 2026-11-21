import type {
  WorkflowConfigDefinition,
  WorkflowDependencyManifest,
  WorkflowVersion,
} from "@/types/workflow/deployment"
import type { VisualWorkflow, WorkflowInterface } from "@/types/workflow/visual"

const FNV_PRIME_32 = 0x01000193
const DIGEST_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35] as const

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(",")}}`
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0
  }
  return hash
}

/** Stable content identity; it detects drift but is not an authenticity signature. */
export function workflowVersionDigest(value: unknown): string {
  const canonical = canonicalize(value)
  const digest = DIGEST_SEEDS.map((seed) => fnv1a32(canonical, seed).toString(16).padStart(8, "0"))
  return `wfv1:${digest.join("")}`
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T
}

/**
 * The workflow a node CALLS when it runs, or `undefined` when it calls none.
 *
 * Only a call is a dependency: the child must be deployed when the parent is
 * admitted, and the admission locks its exact version under the node id.
 * Other references to a workflow are not calls — a `trigger.workflow.completed`
 * names the workflow whose completions it listens to, an `eval.run` names what
 * it evaluates — and treating them as dependencies let an unrelated
 * unpublish block every formal run of the subscriber. A disabled node never
 * runs, and an ensemble whose target is an agent turn calls no workflow.
 */
export function workflowCallTargetOf(node: VisualWorkflow["nodes"][number]): string | undefined {
  if (node.data?.disabled === true) return undefined
  const params = (node.data?.params ?? {}) as Record<string, unknown>
  if (node.type === "flow.subworkflow") {
    const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim() : ""
    return workflowId || undefined
  }
  if (node.type === "ai.ensemble") {
    const target =
      params.target && typeof params.target === "object"
        ? (params.target as Record<string, unknown>)
        : undefined
    if (target?.kind !== "subworkflow") return undefined
    const workflowId = typeof target.workflowId === "string" ? target.workflowId.trim() : ""
    return workflowId || undefined
  }
  return undefined
}

export function deriveWorkflowDependencyManifest(
  workflow: VisualWorkflow
): WorkflowDependencyManifest {
  const nodeTypes = new Map<string, WorkflowDependencyManifest["nodeTypes"][number]>()
  const workflows = new Map<string, WorkflowDependencyManifest["workflows"][number]>()

  for (const node of workflow.nodes) {
    nodeTypes.set(`${node.type}@${node.typeVersion}`, {
      kind: node.type,
      typeVersion: node.typeVersion,
    })
    const workflowId = workflowCallTargetOf(node)
    if (workflowId) workflows.set(`${node.id}:${workflowId}`, { workflowId, nodeId: node.id })
  }

  const credentials = Object.entries(workflow.credentials ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, ref]) => ({ key, refId: ref.id, ...(ref.kind ? { kind: ref.kind } : {}) }))

  return {
    nodeTypes: [...nodeTypes.values()].sort((left, right) =>
      `${left.kind}@${left.typeVersion}`.localeCompare(`${right.kind}@${right.typeVersion}`)
    ),
    workflows: [...workflows.values()].sort((left, right) =>
      `${left.nodeId}:${left.workflowId}`.localeCompare(`${right.nodeId}:${right.workflowId}`)
    ),
    credentials,
  }
}

export function createWorkflowVersion(input: {
  workflow: VisualWorkflow
  workflowInterface: WorkflowInterface
  accountId: string
  sequence: number
  createdAt: number
  createdBy?: string
  versionName?: string
  releaseNotes?: string
}): WorkflowVersion {
  const definition = cloneSerializable({
    ...input.workflow,
    interface: input.workflowInterface,
    published: undefined,
    pinData: undefined,
    // Operator pause overrides are runtime state of the draft row, never part
    // of an immutable artifact (WF-07, `lib/workflow/runtime/trigger-pauses.ts`).
    triggerPauses: undefined,
  })
  const dependencyManifest = deriveWorkflowDependencyManifest(definition)
  const configDefinition: WorkflowConfigDefinition = {
    constants: { ...(definition.variables ?? {}) },
    secretRefs: dependencyManifest.credentials.map(({ key, refId, kind }) => ({
      key,
      refId,
      ...(kind ? { kind } : {}),
    })),
  }
  const digest = workflowVersionDigest({
    definition,
    interface: input.workflowInterface,
    dependencyManifest,
    configDefinition,
  })

  return {
    id: `wfv_${input.workflow.id}_${input.sequence}`,
    accountId: input.accountId,
    workflowId: input.workflow.id,
    sequence: input.sequence,
    definition,
    interface: cloneSerializable(input.workflowInterface),
    dependencyManifest,
    configDefinition,
    digest,
    name: input.workflow.name,
    description: input.workflow.description,
    ...(input.versionName?.trim() ? { versionName: input.versionName.trim() } : {}),
    ...(input.releaseNotes?.trim() ? { releaseNotes: input.releaseNotes.trim() } : {}),
    createdAt: input.createdAt,
    createdBy: input.createdBy,
  }
}

export function workflowDeploymentId(
  accountId: string,
  workflowId: string,
  environment: string
): string {
  return `wfd_${workflowVersionDigest({ accountId, workflowId, environment }).slice("wfv1:".length)}`
}
