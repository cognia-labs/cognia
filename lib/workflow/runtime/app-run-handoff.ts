/**
 * The wire contract of a Workflow App run placed on another Host (ADR-0136
 * placement contract).
 *
 * The serving Host is the App's authority: it authorizes the request, counts
 * the quota, reserves the idempotent invocation and freezes the release's
 * version in one local transaction. Only then does a durable host-dispatch
 * job (`schedule-handoff` domain, kind {@link WORKFLOW_APP_RUN_HANDOFF_KIND})
 * carry that exact admission to the Host the Run Policy chose. The target
 * admits the locked version once per job (`workflow_app_handoff_create`, keyed
 * by the serving invocation id) and never counts the App's quota a second
 * time. Status, events and cancel then go to the target through the
 * host-scoped `workflow_handoff_run_get` / `workflow_handoff_run_cancel`,
 * which answer only for runs that same calling Host admitted.
 */

import type {
  WorkflowApiEventView,
  WorkflowApiRunView,
} from "@/lib/workflow/api/workflow-api-service"
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import type { WorkflowDependencyLock } from "@/types/workflow/deployment"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

export const WORKFLOW_APP_RUN_HANDOFF_KIND = "workflow.app-run"

/** Everything a candidate Host must answer before an App run may be placed on it. */
export const WORKFLOW_APP_RUN_HANDOFF_OPERATIONS = Object.freeze([
  "workflow_placement_probe",
  "workflow_app_handoff_create",
  "workflow_handoff_run_get",
  "workflow_handoff_run_cancel",
])

export type WorkflowAppRunInitiator = NonNullable<WorkflowTriggeredFrom["initiator"]>

/** The exact immutable artifact the release locked, as the target must admit it. */
export interface WorkflowAppRunHandoffBinding {
  workflowId: string
  versionId: string
  deploymentId: string
  deploymentRevision: number
  expectedVersionDigest: string
  dependencyLock?: WorkflowDependencyLock
}

/** The run payload, identical to what a local App run is admitted with. */
export interface WorkflowAppRunHandoffRunPayload {
  input: unknown
  appId: string
  appReleaseId: string
}

/** The host-dispatch job payload. Its idempotency key is the serving invocation id. */
export interface WorkflowAppRunHandoffPayload extends Record<string, unknown> {
  invocationId: string
  /** The run id the serving Host already handed its caller; the target mints it. */
  runId: string
  /** `app:<appId>:release:<releaseId>:<principal>`; stays with the serving ledger. */
  appCaller: string
  binding: WorkflowAppRunHandoffBinding
  payload: WorkflowAppRunHandoffRunPayload
  initiator?: WorkflowAppRunInitiator
}

/** `workflow_app_handoff_create`'s request: the job minus serving-side bookkeeping. */
export interface WorkflowAppHandoffCreateRequest
  extends WorkflowAppRunHandoffBinding, Record<string, unknown> {
  idempotencyKey: string
  runId: string
  payload: WorkflowAppRunHandoffRunPayload
  initiator?: WorkflowAppRunInitiator
}

export interface WorkflowAppRunHandoffRefusal {
  code: string
  message: string
  /** A refusal the target expects to clear by itself (its run capacity). */
  retryable: boolean
}

export type WorkflowAppHandoffCreateReply =
  | { outcome: "accepted"; runId: string; status: string }
  | { outcome: "refused"; refusal: WorkflowAppRunHandoffRefusal }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function isWorkflowAppRunHandoffBinding(
  value: unknown
): value is WorkflowAppRunHandoffBinding {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.workflowId) &&
    isNonEmptyString(value.versionId) &&
    isNonEmptyString(value.deploymentId) &&
    Number.isSafeInteger(value.deploymentRevision) &&
    (value.deploymentRevision as number) >= 0 &&
    isNonEmptyString(value.expectedVersionDigest) &&
    (value.dependencyLock === undefined || isRecord(value.dependencyLock))
  )
}

export function isWorkflowAppRunHandoffRunPayload(
  value: unknown
): value is WorkflowAppRunHandoffRunPayload {
  return (
    isRecord(value) &&
    "input" in value &&
    isNonEmptyString(value.appId) &&
    isNonEmptyString(value.appReleaseId)
  )
}

export function isWorkflowAppRunHandoffPayload(
  value: unknown
): value is WorkflowAppRunHandoffPayload {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.invocationId) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.appCaller) &&
    value.appCaller.startsWith("app:") &&
    isWorkflowAppRunHandoffBinding(value.binding) &&
    isWorkflowAppRunHandoffRunPayload(value.payload) &&
    (value.initiator === undefined || isRecord(value.initiator))
  )
}

/** Parse the target's create reply; anything else is a transport-level failure. */
export function parseWorkflowAppHandoffCreateReply(
  value: unknown
): WorkflowAppHandoffCreateReply | undefined {
  if (!isRecord(value)) return undefined
  if (value.outcome === "accepted" && isNonEmptyString(value.runId)) {
    return {
      outcome: "accepted",
      runId: value.runId,
      status: typeof value.status === "string" ? value.status : "pending",
    }
  }
  if (value.outcome === "refused" && isRecord(value.refusal)) {
    const refusal = value.refusal
    if (isNonEmptyString(refusal.code) && typeof refusal.message === "string") {
      return {
        outcome: "refused",
        refusal: {
          code: refusal.code,
          message: refusal.message,
          retryable: refusal.retryable === true,
        },
      }
    }
  }
  return undefined
}

/** Token and cost usage a Host recorded for one run, in the App quota's units. */
export interface HandoffRunUsage {
  tokens: number
  costUsd: number
  costKnown: boolean
}

/** The run's Host's verdict on disclosing a payload derived from the run. */
export type HandoffRunDisclosure =
  { outcome: "allow" } | { outcome: "withhold"; reason: string; persons: PrincipalRefV1[] }

/** `workflow_handoff_run_get`'s request. */
export interface HandoffRunGetRequest extends Record<string, unknown> {
  runId: string
  /** Present to also read an event page after this cursor. */
  afterSequence?: number
  limit?: number
  /** Present to have the run's Host judge a public share of `payload`. */
  disclosure?: { payload: string; label: string }
}

/** `workflow_handoff_run_get`'s reply. `run: null` = no run this caller handed over. */
export interface HandoffRunReply {
  run: WorkflowApiRunView | null
  usage?: HandoffRunUsage
  events?: { events: WorkflowApiEventView[]; terminal: boolean }
  disclosure?: HandoffRunDisclosure
}

/** `workflow_handoff_run_cancel`'s reply. */
export interface HandoffRunCancelReply {
  runId: string
  found: boolean
  cancelled: boolean
  mode: string
}
