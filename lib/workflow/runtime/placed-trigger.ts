import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { enqueueHostDispatch, type EnqueueHostDispatchInput } from "@/lib/db/host-dispatch-queue"
import { getDb } from "@/lib/db/schema"
import {
  resolveWorkflowDeployment,
  type ResolvedWorkflowDeployment,
} from "@/lib/db/workflow-deployments"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
import type { PlacementConstraint } from "@/lib/placement/types"
import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"
import type { TriggerEvent, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { executeDeployedWorkflow, type ExecuteDeployedWorkflowInput } from "./execution-authority"
import { isLocalWorkflowHostRef, localWorkflowHostRef } from "./local-host-ref"
import { webhookHoldsResponse } from "./webhook-admission"
import { selectWorkflowHost, type WorkflowHostCandidate } from "./workflow-placement"

export interface WorkflowRemoteHostRef {
  ref: string
}

export interface WorkflowPlacementProbeReply {
  compatible: boolean
  deploymentDigest?: string
  activeUnits: number
  maxUnits: number
}

export interface PlacedTriggerDeps {
  resolveDeployment: (workflowId: string) => Promise<ResolvedWorkflowDeployment | undefined>
  executeLocal: (input: ExecuteDeployedWorkflowInput) => Promise<{ runId: string }>
  getLocalActiveUnits: (workflowId: string) => Promise<number>
  listRemoteHosts: () =>
    readonly WorkflowRemoteHostRef[] | Promise<readonly WorkflowRemoteHostRef[]>
  probeRemote: (
    hostRef: string,
    input: { deploymentId: string; expectedVersionDigest: string }
  ) => Promise<WorkflowPlacementProbeReply>
  enqueueHandoff: (input: EnqueueHostDispatchInput) => Promise<HostDispatchJobRow>
  accountId: () => string
  localHostRef: () => string
  now: () => number
}

/**
 * What a placed trigger was durably admitted as: a run on this Host (its
 * invocation is reserved), or a durable handoff to another Host (the target
 * mints the run when it accepts the job).
 */
export type WorkflowAdmissionReceipt =
  { kind: "run"; runId: string } | { kind: "handoff"; dispatchId: string; targetRef: string }

export interface DispatchPlacedWorkflowTriggerInput {
  event: TriggerEvent
  idempotencyKey?: string
  triggeredBy?: WorkflowTriggeredFrom
  /** Awaited before the run starts (local) or right after the handoff is durable. */
  onAdmitted?: (receipt: WorkflowAdmissionReceipt) => unknown
}

export type PlacedWorkflowTriggerResult =
  { kind: "local"; runId: string } | { kind: "remote"; dispatchId: string; targetRef: string }

/** What a trigger handoff needs a candidate Host to answer. */
export const TRIGGER_HANDOFF_OPERATIONS = Object.freeze([
  "workflow_placement_probe",
  "workflow_handoff_create",
])

/**
 * Enrolled Hosts whose feature manifest answers every operation in `operations`
 * under `workflow.execution`, so a caller never selects a Host that cannot take
 * (or later report on) the work it hands over.
 */
export async function listWorkflowExecutionHosts(
  operations: readonly string[]
): Promise<WorkflowRemoteHostRef[]> {
  // The renderer owns the enrolled-host credential book. A headless Host can
  // identify itself (below), but it must not invent outbound credentials or a
  // second server-side roster just to discover other Hosts.
  const { useRemoteHostStore } = await import("@/stores/remote-host/remote-host-store")
  return useRemoteHostStore.getState().hosts.flatMap((host) => {
    const manifest = host.featureManifest
    if (
      manifest?.schemaVersion !== 2 ||
      !operations.every((operation) =>
        supportsHostFeatureOperation(manifest, "workflow.execution", operation)
      )
    ) {
      return []
    }
    return [{ ref: manifest.hostIdentity.id }]
  })
}

function defaultListRemoteHosts(): Promise<WorkflowRemoteHostRef[]> {
  return listWorkflowExecutionHosts(TRIGGER_HANDOFF_OPERATIONS)
}

export async function probeWorkflowExecutionHost(
  hostRef: string,
  input: { deploymentId: string; expectedVersionDigest: string }
): Promise<WorkflowPlacementProbeReply> {
  const target = await openRemoteHostTarget(hostRef)
  try {
    const reply = await target.transport.call<WorkflowPlacementProbeReply>(
      "workflow_placement_probe",
      input
    )
    if (
      !reply ||
      typeof reply.compatible !== "boolean" ||
      !Number.isFinite(reply.activeUnits) ||
      !Number.isFinite(reply.maxUnits)
    ) {
      throw new Error("workflow placement probe returned a malformed response")
    }
    return reply
  } finally {
    target.close()
  }
}

const defaultDeps: PlacedTriggerDeps = {
  resolveDeployment: (workflowId) => resolveWorkflowDeployment(workflowId),
  executeLocal: executeDeployedWorkflow,
  getLocalActiveUnits: (workflowId) =>
    getDb()
      .workflowRuns.where("workflowId")
      .equals(workflowId)
      .filter((run) => ["pending", "running", "waiting", "paused"].includes(run.status))
      .count(),
  listRemoteHosts: defaultListRemoteHosts,
  probeRemote: probeWorkflowExecutionHost,
  enqueueHandoff: enqueueHostDispatch,
  accountId: getActiveAccountId,
  localHostRef: localWorkflowHostRef,
  now: Date.now,
}

function localExecutionInput(
  input: DispatchPlacedWorkflowTriggerInput
): ExecuteDeployedWorkflowInput {
  return {
    workflowId: input.event.workflowId,
    entrypoint: "trigger",
    caller: input.event.kind,
    triggerKind: input.event.kind,
    triggerId: input.event.triggerId,
    triggerBinding: input.event.binding,
    triggerOriginAt: input.event.originAt,
    payload: input.event.payload,
    triggeredBy: input.triggeredBy,
    idempotencyKey: input.idempotencyKey,
    onAdmitted: (runId) => input.onAdmitted?.({ kind: "run", runId }),
  }
}

/**
 * Resolve one published top-level trigger to this Host or a durable remote
 * handoff. Subworkflow and node execution stay colocated with their parent.
 */
export async function dispatchPlacedWorkflowTrigger(
  input: DispatchPlacedWorkflowTriggerInput,
  deps: PlacedTriggerDeps = defaultDeps
): Promise<PlacedWorkflowTriggerResult> {
  const resolved = await deps.resolveDeployment(input.event.workflowId)
  if (!resolved) {
    const execution = await deps.executeLocal(localExecutionInput(input))
    return { kind: "local", runId: execution.runId }
  }

  const constraint = resolved.version.definition.settings.runOn ?? { mode: "colocate" as const }
  // A webhook awaiting an `io.webhook.respond` reply is held open on THIS
  // Host's router: only a run admitted here can answer it (WF-09). Publishing
  // refuses a remote pin for such a workflow; an older version published
  // before that check still runs where its caller is waiting.
  if (constraint.mode === "colocate" || webhookHoldsResponse(input.event)) {
    const execution = await deps.executeLocal(localExecutionInput(input))
    return { kind: "local", runId: execution.runId }
  }

  const enqueueRemoteHandoff = async (targetRef: string): Promise<PlacedWorkflowTriggerResult> => {
    const row = await deps.enqueueHandoff({
      accountId: deps.accountId(),
      domain: "schedule-handoff",
      targetRef,
      kind: "workflow.trigger",
      payload: {
        deploymentId: resolved.deployment.id,
        expectedVersionDigest: resolved.version.digest,
        trigger: input.event,
      },
      idempotencyKey: input.idempotencyKey ?? `workflow-handoff:${crypto.randomUUID()}`,
      label: input.event.workflowId,
    })
    await input.onAdmitted?.({ kind: "handoff", dispatchId: row.id, targetRef: row.targetRef })
    return { kind: "remote", dispatchId: row.id, targetRef: row.targetRef }
  }

  const host = await resolveWorkflowExecutionHost(
    {
      workflowId: input.event.workflowId,
      deploymentId: resolved.deployment.id,
      expectedVersionDigest: resolved.version.digest,
      constraint,
      maxUnits: resolved.version.definition.settings.concurrency,
    },
    deps
  )
  if (host.kind === "local") {
    const execution = await deps.executeLocal(localExecutionInput(input))
    return { kind: "local", runId: execution.runId }
  }
  return enqueueRemoteHandoff(host.ref)
}

export interface ResolveWorkflowExecutionHostInput {
  workflowId: string
  deploymentId: string
  /** Digest of the immutable version the work must run. */
  expectedVersionDigest: string
  constraint: PlacementConstraint
  /** This Host's capacity for the workflow (its version's `settings.concurrency`). */
  maxUnits: number
}

export type WorkflowExecutionHost = { kind: "local" } | { kind: "remote"; ref: string }

/**
 * The Run Policy decision shared by every top-level entry that may run
 * elsewhere (published triggers, a Workflow App's async HTTP run): `colocate`
 * and a pin to this Host stay here, a pin elsewhere is honoured without a
 * probe, and `auto` probes the reachable Hosts and lets `selectWorkflowHost`
 * pick by liveness, capacity, load and the exact version digest.
 */
export async function resolveWorkflowExecutionHost(
  input: ResolveWorkflowExecutionHostInput,
  deps: Pick<
    PlacedTriggerDeps,
    "getLocalActiveUnits" | "listRemoteHosts" | "probeRemote" | "localHostRef" | "now"
  >
): Promise<WorkflowExecutionHost> {
  const { constraint } = input
  if (constraint.mode === "colocate") return { kind: "local" }
  // A pinned target is an operator decision, not a best-effort candidate.
  // Persist the occurrence before attempting transport so an offline Host or
  // a temporarily stale deployment cannot make cron/webhook events disappear.
  // The receiver still validates the exact immutable digest on every retry.
  const localHostRef = deps.localHostRef()
  if (constraint.mode === "pinned") {
    return isLocalWorkflowHostRef(constraint.ref, localHostRef)
      ? { kind: "local" }
      : { kind: "remote", ref: constraint.ref }
  }

  const now = deps.now()
  const localActiveUnits = await deps.getLocalActiveUnits(input.workflowId)
  const local: WorkflowHostCandidate = {
    ref: localHostRef,
    kind: "local",
    liveness: { online: true, lastSeenAt: now, source: "local" },
    provides: [],
    activeUnits: localActiveUnits,
    maxUnits: Math.max(1, input.maxUnits),
    deploymentDigest: input.expectedVersionDigest,
  }
  const refs = await deps.listRemoteHosts()
  const remoteCandidates = await Promise.all(
    refs.map(async ({ ref }): Promise<WorkflowHostCandidate> => {
      try {
        const probe = await deps.probeRemote(ref, {
          deploymentId: input.deploymentId,
          expectedVersionDigest: input.expectedVersionDigest,
        })
        return {
          ref,
          kind: "remote-host",
          liveness: { online: true, lastSeenAt: now, source: "request" },
          provides: [],
          activeUnits: Math.max(0, probe.activeUnits),
          maxUnits: Math.max(1, probe.maxUnits),
          deploymentDigest: probe.deploymentDigest ?? null,
        }
      } catch {
        return {
          ref,
          kind: "remote-host",
          liveness: { online: false, lastSeenAt: 0, source: "request" },
          provides: [],
          activeUnits: 0,
          maxUnits: 1,
          deploymentDigest: null,
        }
      }
    })
  )
  const selection = selectWorkflowHost({
    constraint,
    candidates: [local, ...remoteCandidates],
    expectedDeploymentDigest: input.expectedVersionDigest,
    now,
  })
  return selection.candidate.kind === "local"
    ? { kind: "local" }
    : { kind: "remote", ref: selection.candidate.ref }
}
