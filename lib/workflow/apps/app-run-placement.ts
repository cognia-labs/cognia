/**
 * Cross-host placement of a Workflow App's async HTTP run (ADR-0136
 * placement contract, WF-13).
 *
 * The serving Host stays the App's authority. One local transaction reserves
 * everything the App owns: the access decision (already made), the quota
 * (counted once, here), the idempotent invocation and the release's locked
 * version. When the release version's Run Policy (`settings.runOn`) selects
 * another Host, that same transaction records the invocation with a
 * `placement` instead of a local run, and enqueues the durable host-dispatch
 * job that carries the admission there. Nothing runs here.
 *
 * Every later read of such an invocation (status, events, cancel, result
 * sharing) goes to the Host that runs it, and what it reports is written back
 * onto the invocation, so concurrency, the daily budgets and the run view stay
 * true on the serving Host. Before the job lands the run reads honestly as
 * queued, never as `run_not_found`. Synchronous App calls, MCP and chat stay
 * colocated: they hold a caller open on this Host.
 */

import { nanoid } from "nanoid"

import { getDb } from "@/lib/db/schema"
import { cancelHostDispatch, enqueueHostDispatch } from "@/lib/db/host-dispatch-queue"
import { getWorkflowVersion, resolveLockedWorkflowDeployment } from "@/lib/db/workflow-deployments"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
import {
  invocationId as workflowInvocationId,
  WorkflowAdmissionError,
} from "@/lib/workflow/runtime/execution-authority"
import {
  listWorkflowExecutionHosts,
  probeWorkflowExecutionHost,
  resolveWorkflowExecutionHost,
  type ResolveWorkflowExecutionHostInput,
  type WorkflowExecutionHost,
} from "@/lib/workflow/runtime/placed-trigger"
import { localWorkflowHostRef } from "@/lib/workflow/runtime/local-host-ref"
import { PlacementWaitingError } from "@/lib/placement/types"
import {
  WORKFLOW_APP_RUN_HANDOFF_KIND,
  WORKFLOW_APP_RUN_HANDOFF_OPERATIONS,
  type HandoffRunDisclosure,
  type HandoffRunReply,
  type HandoffRunUsage,
  type WorkflowAppRunHandoffPayload,
} from "@/lib/workflow/runtime/app-run-handoff"
import type {
  WorkflowApiEventView,
  WorkflowApiRunView,
} from "@/lib/workflow/api/workflow-api-service"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ResolvedWorkflowAppRelease } from "@/types/workflow/app"
import type {
  WorkflowDependencyBinding,
  WorkflowInvocation,
  WorkflowInvocationPlacement,
} from "@/types/workflow/deployment"
import type { RunStatus } from "@/types/workflow/visual"
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import { emitWorkflowAppQuotaAlert } from "./alert-service"
import {
  authorizeWorkflowAppRequest,
  workflowAppCaller,
  workflowAppReleaseHasQuota,
  type WorkflowAppRequestActor,
} from "./app-execution"
import { assertWorkflowAppAdmissionQuota, WorkflowAppQuotaError } from "./quota-service"

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"])
const RUN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
])
const DEFAULT_TARGET_TIMEOUT_MS = 10_000

/** What a public caller learns about where its run is; never the Host's identity. */
export interface WorkflowAppRunPlacementView {
  state: WorkflowInvocationPlacement["state"]
  /** False when the run's Host could not be asked just now; the status is the last it reported. */
  reachable?: boolean
}

export type WorkflowAppRunView = WorkflowApiRunView & { placement?: WorkflowAppRunPlacementView }

/** Raised when a placed run's Host cannot answer a read that has no local fallback. */
export class WorkflowAppRunHostUnavailableError extends Error {
  readonly code = "run_host_unavailable" as const

  constructor(message = "The Host running this application run is not reachable") {
    super(message)
    this.name = "WorkflowAppRunHostUnavailableError"
  }
}

export interface WorkflowAppRunPlacementDeps {
  resolveHost: (input: ResolveWorkflowExecutionHostInput) => Promise<WorkflowExecutionHost>
  openTarget: (hostRef: string) => Promise<{
    transport: Pick<Transport, "call">
    close: () => void
  }>
  now: () => number
  newRunId: () => string
  targetTimeoutMs: number
}

/** Same shape as a locally admitted run id, so callers cannot tell them apart. */
function newRunId(): string {
  return `run_${nanoid(12)}`
}

const defaultDeps: WorkflowAppRunPlacementDeps = {
  resolveHost: (input) =>
    resolveWorkflowExecutionHost(input, {
      getLocalActiveUnits: (workflowId) =>
        getDb()
          .workflowRuns.where("workflowId")
          .equals(workflowId)
          .filter((run) => ["pending", "running", "waiting", "paused"].includes(run.status))
          .count(),
      listRemoteHosts: () => listWorkflowExecutionHosts(WORKFLOW_APP_RUN_HANDOFF_OPERATIONS),
      probeRemote: probeWorkflowExecutionHost,
      localHostRef: localWorkflowHostRef,
      now: Date.now,
    }),
  openTarget: (hostRef) => openRemoteHostTarget(hostRef),
  now: Date.now,
  newRunId,
  targetTimeoutMs: DEFAULT_TARGET_TIMEOUT_MS,
}

function withDefaults(
  deps: Partial<WorkflowAppRunPlacementDeps> = {}
): WorkflowAppRunPlacementDeps {
  return { ...defaultDeps, ...deps }
}

export interface PlacedWorkflowAppAdmission {
  runId: string
  invocationId: string
  dispatchId: string
  /** True when an earlier request with the same idempotency key already placed it. */
  reused: boolean
}

function placedAdmission(
  invocation: WorkflowInvocation,
  reused: boolean
): PlacedWorkflowAppAdmission {
  return {
    runId: invocation.runId!,
    invocationId: invocation.id,
    dispatchId: invocation.placement!.dispatchId,
    reused,
  }
}

/**
 * Admit an App run on another Host when its Run Policy says so.
 *
 * Returns `undefined` when the run belongs here (colocated policy, a pin to
 * this Host, `auto` choosing this Host, a synchronous caller, or an earlier
 * local admission under the same idempotency key): the caller then takes the
 * unchanged local path. A replay of an earlier placed admission returns it,
 * whatever the caller's mode, so one key never names two runs.
 */
export async function admitWorkflowAppRunPlacement(
  input: {
    resolved: ResolvedWorkflowAppRelease
    actor: WorkflowAppRequestActor
    input: unknown
    idempotencyKey: string
    /** Only an async HTTP caller may be placed; a held caller stays colocated. */
    placeable: boolean
  },
  overrides: Partial<WorkflowAppRunPlacementDeps> = {}
): Promise<PlacedWorkflowAppAdmission | undefined> {
  const deps = withDefaults(overrides)
  const { app, release } = input.resolved
  const authorization = authorizeWorkflowAppRequest(release, input.actor)
  const caller = workflowAppCaller(input.resolved, authorization)
  const id = workflowInvocationId({
    accountId: app.accountId,
    entrypoint: "http",
    deploymentId: release.deploymentId,
    caller,
    idempotencyKey: input.idempotencyKey,
  })
  const existing = await getDb().workflowInvocations.get(id)
  if (existing) return existing.placement ? placedAdmission(existing, true) : undefined
  if (!input.placeable) return undefined

  const version = await getWorkflowVersion(release.versionId)
  // A missing version is the local path's error to raise, in its own words.
  if (!version || version.workflowId !== release.workflowId) return undefined
  const constraint = version.definition.settings.runOn ?? { mode: "colocate" as const }
  if (constraint.mode === "colocate") return undefined
  let host: WorkflowExecutionHost
  try {
    host = await deps.resolveHost({
      workflowId: release.workflowId,
      deploymentId: release.deploymentId,
      expectedVersionDigest: version.digest,
      constraint,
      maxUnits: version.definition.settings.concurrency,
    })
  } catch (error) {
    // `auto` found no Host with room: the local admission refuses with the
    // App's usual concurrency answer instead of a placement-internal error.
    if (error instanceof PlacementWaitingError) return undefined
    throw error
  }
  if (host.kind === "local") return undefined

  const lockedDependency: WorkflowDependencyBinding = {
    workflowId: release.workflowId,
    versionId: release.versionId,
    deploymentId: release.deploymentId,
    deploymentRevision: release.deploymentRevision,
    dependencyLock: release.dependencyLock,
  }
  const resolvedDeployment = await resolveLockedWorkflowDeployment(lockedDependency, {
    entrypoint: "http",
    caller,
    idempotencyKey: input.idempotencyKey,
  })
  if (!resolvedDeployment) {
    throw new WorkflowAdmissionError(
      "deployment-not-found",
      `No active deployment ${release.deploymentId} for workflow ${release.workflowId}`
    )
  }
  // The same input contract a local admission enforces, refused here rather
  // than by the target so a bad request never costs a dispatch.
  const inputSchema = resolvedDeployment.version.interface.inputSchema
  if (inputSchema && Object.keys(inputSchema).length > 0) {
    const validation = validateAgainstJsonSchema(inputSchema, input.input ?? {})
    if (!validation.ok) {
      throw new WorkflowAdmissionError(
        "input-schema-violation",
        `Workflow input does not match the deployed schema: ${validation.errors.join("; ")}`,
        { errors: validation.errors }
      )
    }
  }
  if (workflowAppReleaseHasQuota(release)) {
    await refreshPlacedWorkflowAppRuns({ accountId: app.accountId, appId: app.id }, overrides)
  }

  const now = deps.now()
  const runId = deps.newRunId()
  const dispatchId = crypto.randomUUID()
  const jobPayload: WorkflowAppRunHandoffPayload = {
    invocationId: id,
    runId,
    appCaller: caller,
    binding: {
      workflowId: release.workflowId,
      versionId: release.versionId,
      deploymentId: release.deploymentId,
      deploymentRevision: release.deploymentRevision,
      expectedVersionDigest: version.digest,
      ...(release.dependencyLock ? { dependencyLock: release.dependencyLock } : {}),
    },
    payload: { input: input.input, appId: app.id, appReleaseId: release.id },
    initiator: {
      authenticated: input.actor.authenticated,
      externalSubjectKey: input.actor.externalSubjectKey,
      ...(input.actor.subjectId ? { principalId: input.actor.subjectId } : {}),
      ...(input.actor.groupIds ? { groupIds: input.actor.groupIds } : {}),
    },
  }
  const invocation: WorkflowInvocation = {
    id,
    accountId: app.accountId,
    entrypoint: "http",
    caller,
    deploymentId: release.deploymentId,
    deploymentRevision: release.deploymentRevision,
    versionId: release.versionId,
    idempotencyKey: input.idempotencyKey,
    runId,
    status: "admitted",
    ...(release.dependencyLock ? { dependencyLock: release.dependencyLock } : {}),
    placement: { hostRef: host.ref, dispatchId, state: "dispatching" },
    createdAt: now,
    updatedAt: now,
  }

  let refusal: unknown
  try {
    const db = getDb()
    await db.transaction(
      "rw",
      [db.workflowInvocations, db.sessionUsage, db.workflowDeployments, db.hostDispatchQueue],
      async () => {
        const deployment = await db.workflowDeployments.get(release.deploymentId)
        if (deployment?.status !== "active" || deployment.accountId !== app.accountId) {
          refusal = new WorkflowAdmissionError(
            "deployment-not-found",
            "The approved workflow deployment is no longer active"
          )
          throw refusal
        }
        try {
          await assertWorkflowAppAdmissionQuota({
            appId: app.id,
            accountId: app.accountId,
            release,
            now,
          })
        } catch (error) {
          refusal = error
          throw error
        }
        await db.workflowInvocations.add(invocation)
        // Same transaction: the ledger row and the job that carries it are one
        // durability unit, so a crash can neither strand a placed invocation
        // without its job nor ship a job whose invocation was never reserved.
        await enqueueHostDispatch({
          id: dispatchId,
          accountId: app.accountId,
          domain: "schedule-handoff",
          targetRef: host.ref,
          kind: WORKFLOW_APP_RUN_HANDOFF_KIND,
          payload: jobPayload,
          idempotencyKey: id,
          runId,
          label: release.workflowId,
          now,
        })
      }
    )
  } catch (error) {
    if (refusal !== undefined) {
      if (refusal instanceof WorkflowAppQuotaError) {
        await emitWorkflowAppQuotaAlert({ app, release, error: refusal })
      }
      throw refusal
    }
    // A concurrent request with the same key won the deterministic primary
    // key; its admission is this request's admission.
    const winner = await getDb().workflowInvocations.get(id)
    if (!winner) throw error
    return winner.placement ? placedAdmission(winner, true) : undefined
  }
  return placedAdmission(invocation, false)
}

// ── The placement ledger ────────────────────────────────────────────────────

async function updatePlacement(
  invocationId: string,
  next: (
    invocation: WorkflowInvocation,
    placement: WorkflowInvocationPlacement
  ) => Partial<WorkflowInvocation> | undefined
): Promise<WorkflowInvocation | undefined> {
  const db = getDb()
  return db.transaction("rw", db.workflowInvocations, async () => {
    const invocation = await db.workflowInvocations.get(invocationId)
    if (!invocation?.placement) return invocation
    const patch = next(invocation, invocation.placement)
    if (!patch) return invocation
    const updated = { ...invocation, ...patch }
    await db.workflowInvocations.put(updated)
    return updated
  })
}

/**
 * The target admitted the run. Returns whether a caller cancelled it while the
 * job was in flight, in which case the delivery cancels it on the target.
 */
export async function recordWorkflowAppRunPlacementAccepted(
  invocationId: string,
  remoteRunId: string,
  now = Date.now()
): Promise<{ cancelRequested: boolean }> {
  const updated = await updatePlacement(invocationId, (invocation, placement) => {
    // A late acceptance after a cancel still names a real run on the target;
    // it is recorded so its cancellation can be seen through.
    if (placement.state === "settled") return undefined
    if (placement.state === "refused" && placement.cancelRequestedAt === undefined) return undefined
    const { refusal: _refusal, ...rest } = placement
    return {
      status:
        invocation.status === "admitted" || invocation.status === "rejected"
          ? "running"
          : invocation.status,
      placement: { ...rest, state: "accepted", remoteRunId, observedAt: now },
      updatedAt: now,
    }
  })
  return { cancelRequested: updated?.placement?.cancelRequestedAt !== undefined }
}

/** The target refused the admission, or the job ran out of road. Terminal. */
export async function recordWorkflowAppRunPlacementRefused(
  invocationId: string,
  refusal: { code: string; message: string },
  now = Date.now()
): Promise<void> {
  await updatePlacement(invocationId, (_invocation, placement) =>
    placement.state === "dispatching"
      ? {
          status: "rejected",
          placement: { ...placement, state: "refused", refusal, observedAt: now },
          updatedAt: now,
        }
      : undefined
  )
}

/** Fixed public wording per refusal; the target's own text stays in the dispatch row. */
function refusalMessage(code: string): string {
  switch (code) {
    case "deployment_not_found":
      return "The workflow deployment is not active on the Host the run was placed on"
    case "deployment_digest_mismatch":
    case "version_not_found":
      return "The Host the run was placed on does not have this release's workflow version"
    case "input_schema_violation":
      return "The input does not match the workflow's input schema"
    case "cancelled":
      return "The run was cancelled before it reached its Host"
    default:
      return "The run could not be handed to its Host"
  }
}

export function workflowAppRunRefusal(code: string): { code: string; message: string } {
  return { code, message: refusalMessage(code) }
}

/**
 * Settle a `dispatching` placement from its durable job, the backstop for an
 * outcome the delivery could not record (exhausted attempts, deadline,
 * cancellation, a write lost between the job and the ledger).
 */
async function reconcileFromDispatch(
  invocation: WorkflowInvocation,
  now: number
): Promise<WorkflowInvocation> {
  const placement = invocation.placement!
  if (placement.state !== "dispatching") return invocation
  const job = await getDb().hostDispatchQueue.get(placement.dispatchId)
  if (job?.remoteRunId && job.status === "succeeded") {
    await recordWorkflowAppRunPlacementAccepted(invocation.id, job.remoteRunId, now)
    return (await getDb().workflowInvocations.get(invocation.id)) ?? invocation
  }
  const leased = job?.status === "inflight" || (job?.leaseExpiresAt ?? 0) > now
  if (
    !job ||
    ((job.status === "failed" || job.status === "deadletter" || job.status === "cancelled") &&
      !leased)
  ) {
    const code = !job
      ? "handoff_lost"
      : job.status === "cancelled"
        ? "cancelled"
        : job.status === "deadletter"
          ? "handoff_exhausted"
          : (job.terminalCode ?? "handoff_failed")
    await recordWorkflowAppRunPlacementRefused(invocation.id, workflowAppRunRefusal(code), now)
    return (await getDb().workflowInvocations.get(invocation.id)) ?? invocation
  }
  return invocation
}

// ── Reads through the run's Host ────────────────────────────────────────────

async function callTarget<T>(
  deps: WorkflowAppRunPlacementDeps,
  hostRef: string,
  command: string,
  payload: Record<string, unknown>
): Promise<T> {
  const target = await deps.openTarget(hostRef)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      target.transport.call<T>(command, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WorkflowAppRunHostUnavailableError()),
          deps.targetTimeoutMs
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    target.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseRunView(value: unknown): WorkflowApiRunView | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (typeof value.runId !== "string" || typeof value.workflowId !== "string") return undefined
  if (typeof value.status !== "string" || !RUN_STATUSES.has(value.status)) return undefined
  if (typeof value.startedAt !== "number") return undefined
  return value as unknown as WorkflowApiRunView
}

function parseUsage(value: unknown): HandoffRunUsage | undefined {
  if (!isRecord(value)) return undefined
  const { tokens, costUsd, costKnown } = value
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return undefined
  if (typeof costKnown !== "boolean") return undefined
  return { tokens, costUsd, costKnown }
}

function parseHandoffRunReply(value: unknown): HandoffRunReply {
  if (!isRecord(value))
    throw new WorkflowAppRunHostUnavailableError("The run's Host returned a malformed reply")
  const run = parseRunView(value.run)
  if (run === undefined)
    throw new WorkflowAppRunHostUnavailableError("The run's Host returned a malformed run")
  const reply: HandoffRunReply = { run }
  const usage = parseUsage(value.usage)
  if (usage) reply.usage = usage
  if (isRecord(value.events) && Array.isArray(value.events.events)) {
    reply.events = {
      events: value.events.events as WorkflowApiEventView[],
      terminal: value.events.terminal === true,
    }
  }
  if (isRecord(value.disclosure)) {
    const disclosure = value.disclosure
    reply.disclosure =
      disclosure.outcome === "allow"
        ? { outcome: "allow" }
        : {
            outcome: "withhold",
            reason: typeof disclosure.reason === "string" ? disclosure.reason : "withheld",
            persons: Array.isArray(disclosure.persons)
              ? (disclosure.persons as PrincipalRefV1[])
              : [],
          }
  }
  return reply
}

/** Write what the target reported back onto the invocation. */
async function recordRemoteObservation(
  invocationId: string,
  reply: HandoffRunReply,
  now: number
): Promise<WorkflowInvocation | undefined> {
  const run = reply.run
  if (!run) return getDb().workflowInvocations.get(invocationId)
  return updatePlacement(invocationId, (invocation, placement) => {
    if (placement.state === "settled" || placement.state === "refused") return undefined
    const terminal = TERMINAL_RUN_STATUSES.has(run.status)
    return {
      status: terminal ? "completed" : "running",
      placement: {
        ...placement,
        state: terminal ? "settled" : "accepted",
        remoteStatus: run.status,
        observedAt: now,
        ...(reply.usage ? { usage: reply.usage } : {}),
        ...(terminal
          ? {
              terminal: {
                status: run.status,
                startedAt: run.startedAt,
                ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
                ...(run.output !== undefined ? { output: run.output } : {}),
                ...(run.error ? { error: run.error } : {}),
              },
            }
          : {}),
      },
      updatedAt: now,
    }
  })
}

function baseView(
  invocation: WorkflowInvocation,
  workflowId: string
): Omit<WorkflowApiRunView, "status" | "startedAt"> {
  return {
    runId: invocation.runId!,
    workflowId,
    versionId: invocation.versionId,
    deploymentId: invocation.deploymentId,
    deploymentRevision: invocation.deploymentRevision,
  }
}

/** The run view of a placed invocation from the ledger alone. */
function viewFromLedger(
  invocation: WorkflowInvocation,
  workflowId: string,
  reachable?: boolean
): WorkflowAppRunView {
  const placement = invocation.placement!
  const base = baseView(invocation, workflowId)
  if (placement.state === "settled" && placement.terminal) {
    return {
      ...base,
      status: placement.terminal.status,
      startedAt: placement.terminal.startedAt,
      ...(placement.terminal.completedAt !== undefined
        ? { completedAt: placement.terminal.completedAt }
        : {}),
      ...(placement.terminal.output !== undefined ? { output: placement.terminal.output } : {}),
      ...(placement.terminal.error ? { error: placement.terminal.error } : {}),
      placement: { state: "settled" },
    }
  }
  if (placement.state === "refused") {
    const refusal = placement.refusal ?? workflowAppRunRefusal("handoff_failed")
    return {
      ...base,
      status: refusal.code === "cancelled" ? "cancelled" : "failed",
      startedAt: invocation.createdAt,
      completedAt: placement.observedAt ?? invocation.updatedAt,
      error: { message: refusal.message, code: refusal.code },
      placement: { state: "refused" },
    }
  }
  return {
    ...base,
    status: placement.remoteStatus ?? "pending",
    startedAt: invocation.createdAt,
    placement: { state: placement.state, ...(reachable === false ? { reachable: false } : {}) },
  }
}

/** Remote run id the target admitted (the requested id when it honoured it). */
function remoteRunIdOf(invocation: WorkflowInvocation): string {
  return invocation.placement?.remoteRunId ?? invocation.runId!
}

/** Resolve the workflow id from the invocation's version (the ledger does not store it). */
async function workflowIdFor(invocation: WorkflowInvocation): Promise<string> {
  const version = await getWorkflowVersion(invocation.versionId)
  return version?.workflowId ?? ""
}

/**
 * Status of a placed invocation: the ledger for a run that has not landed,
 * was refused or settled; otherwise the target, with its answer written back.
 * An unreachable target yields the last reported status, marked unreachable.
 */
export async function readPlacedWorkflowAppRun(
  invocation: WorkflowInvocation,
  overrides: Partial<WorkflowAppRunPlacementDeps> = {}
): Promise<WorkflowAppRunView> {
  const deps = withDefaults(overrides)
  const workflowId = await workflowIdFor(invocation)
  const current = await reconcileFromDispatch(invocation, deps.now())
  const placement = current.placement!
  if (placement.state !== "accepted") return viewFromLedger(current, workflowId)
  let reply: HandoffRunReply
  try {
    reply = parseHandoffRunReply(
      await callTarget<unknown>(deps, placement.hostRef, "workflow_handoff_run_get", {
        runId: remoteRunIdOf(current),
      })
    )
  } catch {
    return viewFromLedger(current, workflowId, false)
  }
  const updated = (await recordRemoteObservation(current.id, reply, deps.now())) ?? current
  if (!reply.run) return viewFromLedger(updated, workflowId, false)
  return {
    ...reply.run,
    runId: current.runId!,
    placement: { state: updated.placement?.state ?? "accepted" },
  }
}

/**
 * Event page of a placed invocation. A run that has not landed has no events
 * yet (and is not terminal); a refused one has none and is terminal. Events
 * live only on the run's Host, so an unreachable Host is an error the caller
 * retries, not an empty page that would end its stream.
 */
export async function listPlacedWorkflowAppRunEvents(
  invocation: WorkflowInvocation,
  page: { afterSequence: number; limit?: number },
  overrides: Partial<WorkflowAppRunPlacementDeps> = {}
): Promise<{ events: WorkflowApiEventView[]; terminal: boolean }> {
  const deps = withDefaults(overrides)
  const current = await reconcileFromDispatch(invocation, deps.now())
  const placement = current.placement!
  if (placement.state === "dispatching") return { events: [], terminal: false }
  if (placement.state === "refused") return { events: [], terminal: true }
  let reply: HandoffRunReply
  try {
    reply = parseHandoffRunReply(
      await callTarget<unknown>(deps, placement.hostRef, "workflow_handoff_run_get", {
        runId: remoteRunIdOf(current),
        afterSequence: page.afterSequence,
        ...(page.limit !== undefined ? { limit: page.limit } : {}),
      })
    )
  } catch (error) {
    if (error instanceof WorkflowAppRunHostUnavailableError) throw error
    throw new WorkflowAppRunHostUnavailableError()
  }
  await recordRemoteObservation(current.id, reply, deps.now())
  if (!reply.run || !reply.events) throw new WorkflowAppRunHostUnavailableError()
  return {
    events: reply.events.events.map((event) => ({ ...event, runId: current.runId! })),
    terminal: reply.events.terminal,
  }
}

/**
 * Cancel a placed invocation. Before the job lands the job itself is
 * cancelled (a job already being delivered is cancelled on the target as soon
 * as it reports acceptance); after, the target cancels its run.
 */
export async function cancelPlacedWorkflowAppRun(
  invocation: WorkflowInvocation,
  overrides: Partial<WorkflowAppRunPlacementDeps> = {}
): Promise<{ runId: string; cancelled: boolean; mode: string }> {
  const deps = withDefaults(overrides)
  const now = deps.now()
  const runId = invocation.runId!
  const current = await reconcileFromDispatch(invocation, now)
  const placement = current.placement!
  if (placement.state === "settled" || placement.state === "refused") {
    return { runId, cancelled: false, mode: "noop" }
  }
  await updatePlacement(current.id, (_invocation, latest) => ({
    placement: { ...latest, cancelRequestedAt: latest.cancelRequestedAt ?? now },
    updatedAt: now,
  }))
  if (placement.state === "dispatching") {
    const job = await getDb().hostDispatchQueue.get(placement.dispatchId)
    const inFlight = job?.status === "inflight"
    await cancelHostDispatch(placement.dispatchId, "cancelled", now)
    if (!inFlight) {
      await recordWorkflowAppRunPlacementRefused(
        current.id,
        workflowAppRunRefusal("cancelled"),
        now
      )
    }
    return {
      runId,
      cancelled: true,
      mode: inFlight ? "handoff-cancel-pending" : "handoff-cancelled",
    }
  }
  let reply: unknown
  try {
    reply = await callTarget<unknown>(deps, placement.hostRef, "workflow_handoff_run_cancel", {
      runId: remoteRunIdOf(current),
    })
  } catch {
    throw new WorkflowAppRunHostUnavailableError()
  }
  if (!isRecord(reply) || typeof reply.cancelled !== "boolean") {
    throw new WorkflowAppRunHostUnavailableError("The run's Host returned a malformed reply")
  }
  return {
    runId,
    cancelled: reply.cancelled,
    mode: typeof reply.mode === "string" ? reply.mode : "remote",
  }
}

/**
 * Ask the target to judge a public share of this run's result. The personal
 * taint of a run lives where it ran, so the verdict is made there; the
 * serving Host never reconstructs it.
 */
export async function judgePlacedWorkflowAppRunDisclosure(
  invocation: WorkflowInvocation,
  disclosure: { payload: string; label: string },
  overrides: Partial<WorkflowAppRunPlacementDeps> = {}
): Promise<HandoffRunDisclosure> {
  const deps = withDefaults(overrides)
  const placement = invocation.placement!
  if (
    placement.state === "dispatching" ||
    placement.state === "refused" ||
    !placement.remoteRunId
  ) {
    return { outcome: "withhold", reason: "Placed run has no result on its Host", persons: [] }
  }
  let reply: HandoffRunReply
  try {
    reply = parseHandoffRunReply(
      await callTarget<unknown>(deps, placement.hostRef, "workflow_handoff_run_get", {
        runId: remoteRunIdOf(invocation),
        disclosure,
      })
    )
  } catch {
    return { outcome: "withhold", reason: "Placed run's Host is not reachable", persons: [] }
  }
  return (
    reply.disclosure ?? {
      outcome: "withhold",
      reason: "Placed run's Host gave no verdict",
      persons: [],
    }
  )
}

/**
 * Bring every unsettled placed run of one App up to date, so a quota count
 * that follows sees which of them still run and what they used. Each Host is
 * asked once per run, in parallel, within the target timeout; an unreachable
 * one leaves its runs counted as active, which is the only safe reading.
 */
export async function refreshPlacedWorkflowAppRuns(
  scope: { accountId: string; appId: string },
  overrides: Partial<WorkflowAppRunPlacementDeps> = {}
): Promise<void> {
  const prefix = `app:${scope.appId}:release:`
  const unsettled = await getDb()
    .workflowInvocations.filter(
      (invocation) =>
        invocation.accountId === scope.accountId &&
        invocation.caller.startsWith(prefix) &&
        invocation.placement !== undefined &&
        (invocation.placement.state === "dispatching" || invocation.placement.state === "accepted")
    )
    .toArray()
  await Promise.all(
    unsettled.map(async (invocation) => {
      try {
        await readPlacedWorkflowAppRun(invocation, overrides)
      } catch {
        // The read already degrades to the ledger; nothing else to settle.
      }
    })
  )
}
