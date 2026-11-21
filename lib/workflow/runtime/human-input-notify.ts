import { workflowExecutionRunId } from "@/lib/execution/workflow-bridge"

import { workflowRunHref } from "@/lib/workflow/runs/run-href"
import type { WorkflowHumanInputRequest } from "@/types/workflow/human-input"
import { emitCompanionEvent } from "./companion-run-events"

export const HUMAN_INPUT_REQUEST_CHANNEL = "workflow://human-input-request"
export const HUMAN_INPUT_PENDING_PUSH_CHANNEL = "workflow://human-input-pending"
export const HUMAN_INPUT_RESOLVED_CHANNEL = "workflow://human-input-resolved"

export interface HumanInputNotifyDeps {
  notify?: (
    input: {
      source: "workflow"
      level: "warning"
      title: string
      body?: string
      href: string
      dedupeKey: string
      directed: true
      sourceRef: { kind: string; id: string }
    },
    host: import("@/lib/notifications/notify").NotifyHostOptions
  ) => Promise<string>
  emit?: (event: string, payload: unknown) => Promise<void>
}

async function defaultNotify(
  input: Parameters<NonNullable<HumanInputNotifyDeps["notify"]>>[0],
  host: import("@/lib/notifications/notify").NotifyHostOptions
): Promise<string> {
  const { notify } = await import("@/lib/notifications/runtime")
  return notify(input, host)
}

export async function notifyHumanInputRequested(
  request: WorkflowHumanInputRequest,
  deps: HumanInputNotifyDeps = {}
): Promise<void> {
  try {
    await (deps.notify ?? defaultNotify)(
      {
        source: "workflow",
        level: "warning",
        title: request.title,
        ...(request.message ? { body: request.message } : {}),
        // The run the request belongs to; paired devices answer it from their
        // pending list, which the companion channels below keep current.
        href: workflowRunHref(request.workflowId, request.runId),
        dedupeKey: request.id,
        directed: true,
        sourceRef: { kind: "workflow-human-input", id: request.id },
      },
      { personalContext: { executionRunId: workflowExecutionRunId(request.runId) } }
    )
  } catch (error) {
    console.warn("human input notify: notification center delivery failed", error)
  }

  // Host-neutral: the publisher is the desktop's Tauri emit or the headless
  // brain's companion bridge, and a no-op where neither exists. Gating this on
  // Tauri left a headless Host's paired devices without any live update.
  const emit = deps.emit ?? emitCompanionEvent
  try {
    await emit(HUMAN_INPUT_REQUEST_CHANNEL, request)
    await emit(HUMAN_INPUT_PENDING_PUSH_CHANNEL, {
      requestId: request.id,
      runId: request.runId,
      workflowId: request.workflowId,
    })
  } catch (error) {
    console.warn("human input notify: companion fan-out failed", error)
  }
}

export async function notifyHumanInputResolved(
  request: Pick<WorkflowHumanInputRequest, "id" | "runId" | "workflowId">,
  status: "completed" | "timed_out" | "cancelled",
  deps: HumanInputNotifyDeps = {}
): Promise<void> {
  try {
    await (deps.emit ?? emitCompanionEvent)(HUMAN_INPUT_RESOLVED_CHANNEL, {
      requestId: request.id,
      runId: request.runId,
      workflowId: request.workflowId,
      status,
    })
  } catch (error) {
    console.warn("human input notify: resolved fan-out failed", error)
  }
}
