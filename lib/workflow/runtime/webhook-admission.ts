/**
 * Admission receipts for plain `trigger.webhook` ingress (WF-08).
 *
 * The Rust router used to answer 2xx the moment it had emitted the trigger
 * event — before Execution Authority had reserved anything. A request that was
 * later refused (not deployed, a stale trigger binding, the concurrency limit)
 * still read as success to its sender, and nothing durable named the run it was
 * supposed to start.
 *
 * Now every webhook request carries an `admissionId`. The router holds the
 * request until the runtime acknowledges admission, through the same
 * `workflow_webhook_respond` reply channel `io.webhook.respond` uses:
 *
 *   - a 2xx reply means the invocation (or a durable handoff to another Host)
 *     was reserved; its `x-cognia-run-id` / `x-cognia-handoff-id` header is the
 *     receipt, and the router then answers with the trigger's configured or
 *     dynamic response carrying that header;
 *   - any other reply is the rejection, returned to the sender as-is;
 *   - no reply within the router's bound is a 503 with `Retry-After`.
 *
 * A redelivery with the same delivery id resolves to the same invocation, so
 * it receives the same run id.
 */

import type { TriggerEvent } from "@/types/workflow/visual"
import { WorkflowAdmissionError } from "./execution-authority"
import type { WorkflowAdmissionReceipt } from "./placed-trigger"
import { respondToWebhook } from "./tauri-bridge"

/** Receipt header naming the admitted run. Lower-case: HTTP header names fold. */
export const WEBHOOK_RUN_ID_HEADER = "x-cognia-run-id"
/** Receipt header naming the durable handoff to another Host. */
export const WEBHOOK_HANDOFF_ID_HEADER = "x-cognia-handoff-id"
/** Seconds a sender should wait before retrying a request the runtime could not take. */
export const WEBHOOK_RETRY_AFTER_SECONDS = "5"

export interface WebhookReply {
  status: number
  body: string
  headers: Record<string, string>
}

function webhookPayload(event: TriggerEvent): Record<string, unknown> | undefined {
  if (event.kind !== "trigger.webhook") return undefined
  const payload = event.payload
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined
}

/** The router's admission correlation id, when this event came from a held request. */
export function webhookAdmissionIdOf(event: TriggerEvent): string | undefined {
  const id = webhookPayload(event)?.admissionId
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/**
 * Whether the router is holding this request open for an `io.webhook.respond`
 * reply. Only the Host whose router holds it can answer, so such a run must be
 * admitted here (WF-09).
 */
export function webhookHoldsResponse(event: TriggerEvent): boolean {
  const id = webhookPayload(event)?.correlationId
  return typeof id === "string" && id.length > 0
}

/** The 2xx acknowledgement the router turns into the sender's receipt. */
export function webhookAdmittedReply(receipt: WorkflowAdmissionReceipt): WebhookReply {
  return {
    status: 202,
    body: "",
    headers:
      receipt.kind === "run"
        ? { [WEBHOOK_RUN_ID_HEADER]: receipt.runId }
        : { [WEBHOOK_HANDOFF_ID_HEADER]: receipt.dispatchId },
  }
}

/** HTTP status for an admission refusal the sender can act on. */
function rejectionStatus(code: string): number {
  switch (code) {
    case "deployment-not-found":
      return 404
    case "scope-denied":
      return 403
    case "input-schema-violation":
      return 422
    case "workflow-concurrency-limit":
      return 503
    default:
      // A stale trigger binding, a dependency that is not deployed or cycles,
      // a corrupt invocation: the registration and the deployment disagree.
      return 409
  }
}

/** The non-2xx reply the router returns to the sender verbatim. */
export function webhookRejectedReply(error: unknown): WebhookReply {
  const json = { "content-type": "application/json" }
  if (error instanceof WorkflowAdmissionError) {
    const status = rejectionStatus(error.code)
    return {
      status,
      body: JSON.stringify({ error: error.message, code: error.code }),
      headers:
        status === 503 ? { ...json, "retry-after": WEBHOOK_RETRY_AFTER_SECONDS } : { ...json },
    }
  }
  // Not a refusal the request can fix: the runtime could not take it right now.
  return {
    status: 503,
    body: JSON.stringify({ error: "workflow admission failed", code: "admission-failed" }),
    headers: { ...json, "retry-after": WEBHOOK_RETRY_AFTER_SECONDS },
  }
}

export interface WebhookAdmissionAck {
  admitted(receipt: WorkflowAdmissionReceipt): Promise<void>
  rejected(error: unknown): Promise<void>
}

/**
 * The once-only acknowledgement for one webhook event, or `undefined` for any
 * other event. The first outcome wins; a later one (an error thrown by the run
 * after it was admitted) is not sent — the router has already answered.
 */
export function webhookAdmissionAck(
  event: TriggerEvent,
  respond: typeof respondToWebhook = respondToWebhook
): WebhookAdmissionAck | undefined {
  const admissionId = webhookAdmissionIdOf(event)
  if (!admissionId) return undefined
  let sent = false
  const send = async (reply: WebhookReply): Promise<void> => {
    if (sent) return
    sent = true
    try {
      // `false` means the router already gave up on this request (its own
      // bound elapsed and the sender got a 503). Nothing more to do here: the
      // admission stands and a redelivery resolves to the same run.
      await respond(admissionId, reply)
    } catch (error) {
      console.warn("workflow webhook admission: acknowledgement failed", error)
    }
  }
  return {
    admitted: (receipt) => send(webhookAdmittedReply(receipt)),
    rejected: (error) => send(webhookRejectedReply(error)),
  }
}
