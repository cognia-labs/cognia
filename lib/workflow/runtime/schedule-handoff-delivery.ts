import { recordHostDispatchRemoteRun } from "@/lib/db/host-dispatch-queue"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
import {
  HostDispatchDeliveryError,
  registerHostDispatchDelivery,
  type HostDispatchDelivery,
} from "@/lib/placement/host-dispatch-delivery"
import type { Transport } from "@/lib/tauri/transport-types"
import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"
import type { TriggerEvent } from "@/types/workflow/visual"
import {
  isWorkflowAppRunHandoffPayload,
  parseWorkflowAppHandoffCreateReply,
  WORKFLOW_APP_RUN_HANDOFF_KIND,
  type WorkflowAppHandoffCreateRequest,
  type WorkflowAppRunHandoffPayload,
} from "./app-run-handoff"

export interface WorkflowScheduleHandoffPayload extends Record<string, unknown> {
  deploymentId: string
  expectedVersionDigest: string
  trigger: TriggerEvent
}

export interface ScheduleHandoffDeliveryDeps {
  openTarget?: (targetRef: string) => Promise<{
    transport: Pick<Transport, "call">
    close: () => void
  }>
  /** Persist the run the target minted. Injected only so tests avoid Dexie. */
  recordRemoteRun?: (dispatchId: string, remoteRunId: string) => Promise<void>
  /**
   * The serving App ledger (`lib/workflow/apps/app-run-placement.ts`), reached
   * lazily so the trigger path never loads the App surface. Injected in tests.
   */
  appLedger?: WorkflowAppRunHandoffLedger
}

/** What a placed App run's delivery tells the serving invocation. */
export interface WorkflowAppRunHandoffLedger {
  accepted: (invocationId: string, remoteRunId: string) => Promise<{ cancelRequested: boolean }>
  refused: (invocationId: string, code: string) => Promise<void>
}

const defaultAppLedger: WorkflowAppRunHandoffLedger = {
  async accepted(invocationId, remoteRunId) {
    const { recordWorkflowAppRunPlacementAccepted } =
      await import("@/lib/workflow/apps/app-run-placement")
    return recordWorkflowAppRunPlacementAccepted(invocationId, remoteRunId)
  },
  async refused(invocationId, code) {
    const { recordWorkflowAppRunPlacementRefused, workflowAppRunRefusal } =
      await import("@/lib/workflow/apps/app-run-placement")
    await recordWorkflowAppRunPlacementRefused(invocationId, workflowAppRunRefusal(code))
  },
}

function isHandoffPayload(value: unknown): value is WorkflowScheduleHandoffPayload {
  if (!value || typeof value !== "object") return false
  const payload = value as Record<string, unknown>
  const trigger = payload.trigger
  if (!trigger || typeof trigger !== "object") return false
  const event = trigger as Record<string, unknown>
  return (
    typeof payload.deploymentId === "string" &&
    payload.deploymentId.length > 0 &&
    typeof payload.expectedVersionDigest === "string" &&
    payload.expectedVersionDigest.length > 0 &&
    typeof event.workflowId === "string" &&
    event.workflowId.length > 0 &&
    typeof event.kind === "string" &&
    typeof event.originAt === "number"
  )
}

/** Deliver one durable top-level trigger to the selected execution Host. */
export function createScheduleHandoffDelivery(
  deps: ScheduleHandoffDeliveryDeps = {}
): HostDispatchDelivery {
  const openTarget = deps.openTarget ?? openRemoteHostTarget
  const recordRemoteRun = deps.recordRemoteRun ?? recordHostDispatchRemoteRun
  const appLedger = deps.appLedger ?? defaultAppLedger
  return async (job) => {
    if (job.domain === "schedule-handoff" && job.kind === WORKFLOW_APP_RUN_HANDOFF_KIND) {
      if (!isWorkflowAppRunHandoffPayload(job.payload)) {
        throw new HostDispatchDeliveryError(
          "malformed",
          false,
          "workflow app-run handoff payload is malformed"
        )
      }
      return deliverAppRunHandoff(job, job.payload, { openTarget, recordRemoteRun, appLedger })
    }
    if (
      job.domain !== "schedule-handoff" ||
      job.kind !== "workflow.trigger" ||
      !isHandoffPayload(job.payload)
    ) {
      throw new HostDispatchDeliveryError(
        "malformed",
        false,
        "schedule-handoff payload is malformed"
      )
    }

    let target: Awaited<ReturnType<typeof openTarget>> | undefined
    try {
      target = await openTarget(job.targetRef)
      const accepted = await target.transport.call<{ runId?: unknown }>(
        "workflow_handoff_create",
        {
          deploymentId: job.payload.deploymentId,
          expectedVersionDigest: job.payload.expectedVersionDigest,
          idempotencyKey: job.idempotencyKey,
          trigger: job.payload.trigger,
        },
        { idempotencyKey: job.idempotencyKey }
      )
      // The source keeps a pointer, never a mirror of the remote journal: one
      // run has one event log, and it lives on the Host that is executing it.
      const remoteRunId = typeof accepted?.runId === "string" ? accepted.runId : undefined
      if (remoteRunId) {
        try {
          await recordRemoteRun(job.id, remoteRunId)
        } catch {
          // A lost pointer costs the Runs surface a link, not the run itself.
        }
      }
      return "succeeded"
    } catch (error) {
      throw new HostDispatchDeliveryError(
        "handoff_failed",
        true,
        `workflow handoff failed: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      target?.close()
    }
  }
}

/**
 * Carry one App run the serving Host already admitted to the Host its Run
 * Policy chose. The target admits the locked version once per job (keyed by
 * the serving invocation id) and answers with a typed outcome: an acceptance
 * is recorded on both the job and the serving invocation; a refusal is
 * terminal and recorded on the invocation, except the target's own run
 * capacity, which retries with the queue's backoff. Transport failures retry.
 */
async function deliverAppRunHandoff(
  job: HostDispatchJobRow,
  payload: WorkflowAppRunHandoffPayload,
  deps: {
    openTarget: NonNullable<ScheduleHandoffDeliveryDeps["openTarget"]>
    recordRemoteRun: NonNullable<ScheduleHandoffDeliveryDeps["recordRemoteRun"]>
    appLedger: WorkflowAppRunHandoffLedger
  }
): Promise<"succeeded"> {
  const request: WorkflowAppHandoffCreateRequest = {
    ...payload.binding,
    idempotencyKey: job.idempotencyKey,
    runId: payload.runId,
    payload: payload.payload,
    ...(payload.initiator ? { initiator: payload.initiator } : {}),
  }
  let target: Awaited<ReturnType<typeof deps.openTarget>> | undefined
  let reply: ReturnType<typeof parseWorkflowAppHandoffCreateReply>
  try {
    target = await deps.openTarget(job.targetRef)
    // No transport Idempotency-Key of our own: the Host replays a receipt for a
    // reused key, which would pin a retryable refusal onto every retry, and it
    // wants a UUID. Exactly-once is the payload's `idempotencyKey` (the
    // serving invocation id), which the target's admission ledger dedupes.
    reply = parseWorkflowAppHandoffCreateReply(
      await target.transport.call<unknown>("workflow_app_handoff_create", request)
    )
    if (!reply) throw new Error("workflow_app_handoff_create returned a malformed reply")
    if (reply.outcome === "accepted") {
      await deps.recordRemoteRun(job.id, reply.runId)
      const { cancelRequested } = await deps.appLedger.accepted(payload.invocationId, reply.runId)
      // A caller cancelled while this job was in flight: the run exists now,
      // so it is cancelled where it runs instead of being left orphaned.
      if (cancelRequested) {
        await target.transport
          .call("workflow_handoff_run_cancel", { runId: reply.runId })
          .catch((error) => {
            console.warn("workflow app-run handoff: cancel after a late acceptance failed", error)
          })
      }
      return "succeeded"
    }
  } catch (error) {
    throw new HostDispatchDeliveryError(
      "handoff_failed",
      true,
      `workflow app-run handoff failed: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    target?.close()
  }
  const { refusal } = reply
  if (refusal.retryable) {
    throw new HostDispatchDeliveryError(refusal.code, true, refusal.message)
  }
  await deps.appLedger.refused(payload.invocationId, refusal.code)
  throw new HostDispatchDeliveryError(refusal.code, false, refusal.message)
}

export function registerScheduleHandoffDelivery(
  deps: ScheduleHandoffDeliveryDeps = {}
): () => void {
  return registerHostDispatchDelivery("schedule-handoff", createScheduleHandoffDelivery(deps))
}
