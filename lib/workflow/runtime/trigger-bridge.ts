/**
 * Trigger bridge — converts Tauri-emitted `workflow:trigger` events into
 * orchestrator runs. Mounts once on app boot via `installTriggerBridge`;
 * cleans up via the returned disposer.
 *
 * The Rust side (cron daemon, eventual webhook receiver, connector inbound
 * tap) emits a fully-typed `TriggerEvent`. The bridge admits the event through
 * Execution Authority, which pins the active production artifact before the
 * orchestrator starts. Failures never crash the listener.
 */

import type { TriggerEvent, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { WorkflowAdmissionError } from "./execution-authority"
import { dispatchPlacedWorkflowTrigger } from "./placed-trigger"
import { deterministicTriggerIdempotencyKey } from "./trigger-idempotency"
import { ackFileWatch, listenTriggerEvents } from "./tauri-bridge"
import { webhookAdmissionAck } from "./webhook-admission"

export type TriggerBridgeDisposer = () => void

/** Origin of a run nobody started by hand: a trigger occurrence. */
export const AUTOMATIC_TRIGGER_ORIGIN: WorkflowTriggeredFrom = Object.freeze({
  source: "trigger",
})

export interface TriggerBridgeDeps {
  dispatchPlaced: typeof dispatchPlacedWorkflowTrigger
  /** The webhook admission receipt channel; injected so tests avoid the native plane. */
  admissionAck?: typeof webhookAdmissionAck
}

export interface TriggerBridgeInstallDeps {
  listen: typeof listenTriggerEvents
  dispatch: typeof dispatchTrigger
}

const defaultTriggerBridgeDeps: TriggerBridgeDeps = {
  dispatchPlaced: dispatchPlacedWorkflowTrigger,
}

/** Subscribe to `workflow:trigger` events. Returns a disposer. */
export async function installTriggerBridge(
  deps: TriggerBridgeInstallDeps = { listen: listenTriggerEvents, dispatch: dispatchTrigger }
): Promise<TriggerBridgeDisposer> {
  return deps.listen(async (raw) => {
    if (!isTriggerEvent(raw)) {
      console.warn("workflow trigger bridge: discarding malformed event", raw)
      return
    }
    try {
      await deps.dispatch(raw)
    } catch (err) {
      console.error("workflow trigger bridge: dispatch failed", {
        workflowId: raw.workflowId,
        kind: raw.kind,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      // A file watch stays muted from the moment it fires until this lands,
      // and `dispatch` above awaits the entire run. That is what makes the
      // mute window strictly contain the run's execution window: every file
      // the run wrote under the watched root was observed while muted and
      // dropped. In a `finally` because a failed run must re-arm the watch
      // just as a successful one does, and the daemon's own timeout is a
      // fail-safe rather than the mechanism.
      if (raw.kind === "trigger.file.watch" && raw.triggerId) {
        await ackFileWatch(raw.workflowId, raw.triggerId)
      }
    }
  })
}

/**
 * Admit the trigger against the production deployment. Exported for tests so
 * they can drive the bridge without going through Tauri.
 */
export async function dispatchTrigger(
  event: TriggerEvent,
  opts?: {
    /**
     * Run origin persisted onto `WorkflowRunRow.triggeredBy` (ADR-0060) —
     * lets companion-originated manual triggers record `source: "api"` +
     * the caller `deviceId`, and the library Run button `"desktop"`.
     * Absent means an automatic trigger occurrence, recorded as
     * {@link AUTOMATIC_TRIGGER_ORIGIN}: before, it fell through to the
     * orchestrator's `"ui"` default, so a cron or webhook run with a risky
     * node waited for an interactive approval locally while the same
     * occurrence forwarded to another Host failed closed as `"api"`.
     */
    triggeredBy?: WorkflowTriggeredFrom
  },
  deps: TriggerBridgeDeps = defaultTriggerBridgeDeps
): Promise<void> {
  const triggerId = resolveTriggerId(event)
  const normalizedEvent =
    triggerId && event.triggerId !== triggerId ? { ...event, triggerId } : event
  // Single canonical fan-in for every trigger path (cron / webhook / connector
  // / chat / plugin all route through here). Resume does NOT call this, so a
  // resumed run correctly does not re-fire the trigger hook.
  // Without a key the ledger lookup in `execution-authority` is skipped
  // outright (`existingInvocation` is only read when one is present), so a
  // redelivered event or a slot reached twice ran twice.
  const idempotencyKey = deterministicTriggerIdempotencyKey({
    workflowId: event.workflowId,
    triggerKind: normalizedEvent.kind,
    ...(normalizedEvent.triggerId ? { triggerId: normalizedEvent.triggerId } : {}),
    ...(typeof normalizedEvent.originAt === "number" ? { originAt: normalizedEvent.originAt } : {}),
    ...(normalizedEvent.occurrenceKey ? { occurrenceKey: normalizedEvent.occurrenceKey } : {}),
  })
  // A webhook request is held by the router until admission is confirmed:
  // its 2xx must name a durably reserved run (or handoff), and a refusal
  // must reach the sender instead of a success it never earned (WF-08).
  const ack = (deps.admissionAck ?? webhookAdmissionAck)(normalizedEvent)
  try {
    const placed = await deps.dispatchPlaced({
      event: normalizedEvent,
      triggeredBy: opts?.triggeredBy ?? AUTOMATIC_TRIGGER_ORIGIN,
      idempotencyKey,
      onAdmitted: async (receipt) => {
        getPluginEventHooks().dispatchWorkflowTriggerFired(
          event.workflowId,
          event.kind,
          event.payload
        )
        await ack?.admitted(receipt)
      },
    })
    // Every admission path reports through `onAdmitted`; this only covers a
    // placement that returned without it, and is a no-op otherwise.
    await ack?.admitted(
      placed.kind === "local"
        ? { kind: "run", runId: placed.runId }
        : { kind: "handoff", dispatchId: placed.dispatchId, targetRef: placed.targetRef }
    )
  } catch (error) {
    await ack?.rejected(error)
    if (error instanceof WorkflowAdmissionError && error.code === "deployment-not-found") {
      console.warn(`workflow trigger bridge: workflow ${event.workflowId} not deployed; ignoring`)
      return
    }
    if (error instanceof WorkflowAdmissionError && error.code === "trigger-binding-invalid") {
      console.warn(`workflow trigger bridge: ${error.message}; ignoring`)
      return
    }
    throw error
  }
}

function resolveTriggerId(event: TriggerEvent): string | undefined {
  if (typeof event.triggerId === "string" && event.triggerId.length > 0) return event.triggerId
  if (!event.payload || typeof event.payload !== "object") return undefined
  const legacyTriggerId = (event.payload as Record<string, unknown>).triggerId
  return typeof legacyTriggerId === "string" && legacyTriggerId.length > 0
    ? legacyTriggerId
    : undefined
}

/**
 * Type predicate for the raw event payload. Validates the minimum shape
 * the orchestrator needs before invoking; strict-checking belongs in zod
 * land and isn't worth the bundle weight here.
 */
export function isTriggerEvent(value: unknown): value is TriggerEvent {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.workflowId === "string" &&
    typeof v.kind === "string" &&
    typeof v.originAt === "number" &&
    (v.triggerId === undefined || typeof v.triggerId === "string") &&
    (v.occurrenceKey === undefined || typeof v.occurrenceKey === "string")
  )
}
