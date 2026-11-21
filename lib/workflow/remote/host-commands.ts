/**
 * The Host side of a paired client's workflow runs (WF-10, WF-15, WF-23).
 *
 * Three answers a companion RPC arm (`lib/companion/desktop-write-source.ts`)
 * hands back:
 *
 *  - {@link startWorkflowPreviewRun} — the phone editor's Run, "Run from here"
 *    and "Run only this node". A draft PREVIEW of this Host's saved copy, with
 *    the desktop canvas's semantics (pinned data honoured, `startStepId` for
 *    run-from-here, the ancestor cone for run-one-step). It answers with the
 *    run id once the run row exists, never after the run.
 *  - {@link triggerPublishedWorkflowRun} — the library's Run: a formal run of
 *    the published deployment through the placed admission path. A workflow
 *    that is not deployed is refused here instead of being swallowed (the
 *    trigger bridge treats an undeployed event as "nothing to do", which made
 *    the phone's queue mark the run sent while no run existed).
 *  - {@link listWorkflowRunEventsPage} — one page of a run's step events. The
 *    events stay on the Host (they are never part of companion sync); a paired
 *    run detail reads them through this controlled, paged read.
 *
 * A refusal is a {@link WorkflowRunRejectedError} (`./run-rejection.ts`). The
 * companion RPC maps it onto a 422 `workflow_run_rejected`
 * (`crates/cognia-companion-rpc/src/rpc.rs`), so a queued run that cannot
 * happen is given up on at once rather than retried, and the client can show
 * why.
 */

import { nanoid } from "nanoid"

import { getDb } from "@/lib/db/schema"
import { getWorkflow } from "@/lib/db/workflows"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { validateWorkflow } from "@/lib/workflow/definition/validate"
import { WorkflowAdmissionError } from "@/lib/workflow/runtime/execution-authority"
import { runWorkflow, type RunWorkflowResult } from "@/lib/workflow/runtime/orchestrator"
import {
  dispatchPlacedWorkflowTrigger,
  type PlacedWorkflowTriggerResult,
  type WorkflowAdmissionReceipt,
} from "@/lib/workflow/runtime/placed-trigger"
import { runSingleNode } from "@/lib/workflow/runtime/run-single-node"
import type {
  RunStatus,
  TriggerEvent,
  VisualWorkflow,
  WorkflowRunEventRow,
  WorkflowRunRow,
  WorkflowTriggeredFrom,
} from "@/types/workflow/visual"

import { WorkflowRunRejectedError } from "./run-rejection"

export type WorkflowPreviewMode = "full" | "from-step" | "single-step"

export interface StartWorkflowPreviewRunInput {
  workflowId: string
  mode: WorkflowPreviewMode
  /** Required for `from-step` and `single-step`. */
  stepId?: string
  triggeredBy: WorkflowTriggeredFrom
}

export interface WorkflowPreviewRunDeps {
  getWorkflow: (id: string) => Promise<VisualWorkflow | undefined>
  runWorkflow: typeof runWorkflow
  runSingleNode: typeof runSingleNode
  getRun: (runId: string) => Promise<WorkflowRunRow | undefined>
  newRunId: () => string
}

const defaultPreviewDeps: WorkflowPreviewRunDeps = {
  getWorkflow,
  runWorkflow,
  runSingleNode,
  getRun: (runId) => getDb().workflowRuns.get(runId),
  newRunId: () => `run_${nanoid(12)}`,
}

/**
 * Start a draft preview of a saved workflow; resolves once its run row exists.
 * On the Host it reads its own saved copy. A process that owns its workflows
 * (a standalone phone) passes `getWorkflow` to preview the editor's copy.
 */
export async function startWorkflowPreviewRun(
  input: StartWorkflowPreviewRunInput,
  overrides: Partial<WorkflowPreviewRunDeps> = {}
): Promise<{ runId: string }> {
  const deps: WorkflowPreviewRunDeps = { ...defaultPreviewDeps, ...overrides }
  if (input.mode !== "full" && !input.stepId) {
    throw new WorkflowRunRejectedError("invalid_request", `${input.mode} needs a stepId`)
  }
  const workflow = await deps.getWorkflow(input.workflowId)
  if (!workflow) {
    throw new WorkflowRunRejectedError(
      "workflow_not_found",
      `Workflow ${input.workflowId} is not on this Host`
    )
  }
  const validation = validateWorkflow(workflow)
  if (!validation.ok) {
    throw new WorkflowRunRejectedError("workflow_invalid", validation.errors.join("; "))
  }
  if (input.stepId && !workflow.nodes.some((node) => node.id === input.stepId)) {
    throw new WorkflowRunRejectedError(
      "step_not_found",
      `Step ${input.stepId} is not in workflow ${workflow.id}`
    )
  }

  const runId = deps.newRunId()
  let persisted: (id: string) => void = () => {}
  const persistedRun = new Promise<string>((resolve) => {
    persisted = resolve
  })
  const run: Promise<RunWorkflowResult> =
    input.mode === "single-step"
      ? deps.runSingleNode({
          workflow,
          nodeId: input.stepId!,
          runId,
          triggeredBy: input.triggeredBy,
          onPersisted: persisted,
        })
      : deps.runWorkflow({
          workflow,
          runId,
          trigger: manualTrigger(workflow.id),
          ...(input.mode === "from-step" ? { startStepId: input.stepId! } : {}),
          // Editor manual runs honour pinned node data; production never does.
          honorPinData: true,
          triggeredBy: input.triggeredBy,
          onPersisted: persisted,
        })

  const first = await Promise.race([
    persistedRun.then((id) => ({ kind: "persisted" as const, id })),
    run.then(
      (result) => ({ kind: "settled" as const, result }),
      (error: unknown) => ({ kind: "threw" as const, error })
    ),
  ])
  if (first.kind === "persisted") {
    // The run goes on without the caller. Its outcome is in its own row.
    void run.catch((error: unknown) => {
      console.warn(`workflow preview ${runId} ended with an error`, error)
    })
    return { runId: first.id }
  }
  if (first.kind === "threw") {
    const message = first.error instanceof Error ? first.error.message : String(first.error)
    throw new WorkflowRunRejectedError("run_not_started", message)
  }
  // Ended before it was announced: a capacity refusal or a failure the
  // orchestrator still recorded is a run the client can open; anything that
  // left no row is a run that never started.
  if (await deps.getRun(runId)) return { runId }
  throw new WorkflowRunRejectedError(
    "run_not_started",
    first.result.error?.message ?? `run ended ${first.result.status} before it started`
  )
}

function manualTrigger(workflowId: string, payload: unknown = {}): TriggerEvent {
  return { workflowId, kind: "trigger.manual", payload, originAt: Date.now() }
}

export type PublishedWorkflowRunAcceptance =
  | { status: "admitted"; runId: string }
  | { status: "handed_off"; dispatchId: string; targetRef: string }

export interface TriggerPublishedWorkflowRunInput {
  workflowId: string
  input?: unknown
  triggeredBy: WorkflowTriggeredFrom
}

export interface PublishedWorkflowRunDeps {
  dispatchPlaced: typeof dispatchPlacedWorkflowTrigger
  onTriggerFired: (event: TriggerEvent) => void
}

const defaultPublishedDeps: PublishedWorkflowRunDeps = {
  dispatchPlaced: dispatchPlacedWorkflowTrigger,
  onTriggerFired: (event) =>
    getPluginEventHooks().dispatchWorkflowTriggerFired(event.workflowId, event.kind, event.payload),
}

/**
 * A formal manual run of the published deployment, answered on admission.
 *
 * Placement may run it here or hand it to another Host; its admission
 * receipt says which (the run id here, the durable handoff there), so the
 * caller is answered as soon as the run is reserved rather than when it ends.
 */
export async function triggerPublishedWorkflowRun(
  input: TriggerPublishedWorkflowRunInput,
  deps: PublishedWorkflowRunDeps = defaultPublishedDeps
): Promise<PublishedWorkflowRunAcceptance> {
  const event = manualTrigger(input.workflowId, input.input ?? null)
  let admitted: (receipt: WorkflowAdmissionReceipt) => void = () => {}
  const admission = new Promise<WorkflowAdmissionReceipt>((resolve) => {
    admitted = resolve
  })
  const dispatch = deps.dispatchPlaced({
    event,
    triggeredBy: input.triggeredBy,
    onAdmitted: (receipt) => {
      deps.onTriggerFired(event)
      admitted(receipt)
    },
  })
  const settled = dispatch.then(
    (result) => ({ kind: "dispatched" as const, result }),
    (error: unknown) => ({ kind: "threw" as const, error })
  )
  const first = await Promise.race([
    settled,
    admission.then((receipt) => ({ kind: "admitted" as const, receipt })),
  ])
  if (first.kind === "admitted") {
    const { receipt } = first
    if (receipt.kind === "run") {
      void dispatch.catch((error: unknown) => {
        console.warn(`workflow manual run ${receipt.runId} ended with an error`, error)
      })
      return { status: "admitted", runId: receipt.runId }
    }
    return { status: "handed_off", dispatchId: receipt.dispatchId, targetRef: receipt.targetRef }
  }
  if (first.kind === "threw") throw rejectionOf(first.error)
  return acceptanceOf(first.result)
}

function acceptanceOf(result: PlacedWorkflowTriggerResult): PublishedWorkflowRunAcceptance {
  return result.kind === "local"
    ? { status: "admitted", runId: result.runId }
    : { status: "handed_off", dispatchId: result.dispatchId, targetRef: result.targetRef }
}

function rejectionOf(error: unknown): Error {
  if (error instanceof WorkflowAdmissionError) {
    return new WorkflowRunRejectedError(error.code, error.message)
  }
  return error instanceof Error ? error : new Error(String(error))
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"])
const DEFAULT_EVENTS_PAGE = 200
const MAX_EVENTS_PAGE = 500

export interface WorkflowRunEventsPage {
  /** The run as this Host holds it; `null` when it has no such run. */
  run: WorkflowRunRow | null
  events: WorkflowRunEventRow[]
  /** Pass back as `afterSequence` for the next page. */
  nextSequence: number
  /** The run is over and this page reached the end of its log. */
  terminal: boolean
}

/** One page of a run's step events, oldest first, after `afterSequence`. */
export async function listWorkflowRunEventsPage(input: {
  runId: unknown
  afterSequence?: unknown
  limit?: unknown
}): Promise<WorkflowRunEventsPage> {
  const { runId } = input
  if (typeof runId !== "string" || !runId.trim() || runId.length > 256) {
    throw new WorkflowRunRejectedError("invalid_request", "runId is required")
  }
  const afterSequence =
    typeof input.afterSequence === "number" && Number.isSafeInteger(input.afterSequence)
      ? Math.max(0, input.afterSequence)
      : 0
  const limit =
    typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MAX_EVENTS_PAGE)
      : DEFAULT_EVENTS_PAGE
  const db = getDb()
  const run = (await db.workflowRuns.get(runId)) ?? null
  if (!run) return { run: null, events: [], nextSequence: afterSequence, terminal: true }
  const events = await db.workflowRunEvents
    .where("[runId+sequence]")
    .between([runId, afterSequence], [runId, Number.MAX_SAFE_INTEGER], false, true)
    .limit(limit)
    .toArray()
  const last = events.at(-1)?.sequence
  return {
    run,
    events,
    nextSequence: typeof last === "number" ? last : afterSequence,
    terminal: TERMINAL.has(run.status) && events.length < limit,
  }
}
